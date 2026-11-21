// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useMemo } from 'react';
import { create } from 'zustand';

import { ApiError } from '../api/_client';
import { listCanvases } from '../api/canvas';
import {
  activateWorkspace,
  createNamedWorkspace,
  getWorkspaceInfo,
  listWorkspaces,
  openFolderWorkspace as adoptFolderWorkspace,
  putWorkspacePath,
  removeWorkspace,
  renameWorkspace as renameWorkspaceRequest,
  type WorkspaceCapabilities,
  type WorkspaceDescriptor,
  type WorkspaceInfo,
  type WorkspaceMode,
} from '../api/workspace';
import {
  getElectronBridge,
  requireDesktopTabSuccess,
} from '../hooks/useElectron';
import { i18n } from '../i18n';
import {
  readApplicationPreference,
  writeApplicationPreference,
} from '../utils/desktopStorage';

import type { CanvasSummary } from '@huabu/shared';

type SpaceSummary = Partial<
  Pick<
    CanvasSummary,
    'nodeCount' | 'updatedAt' | 'parentSpaceId' | 'parentEntryNodeId'
  >
>;

const WORLD_ENABLED_KEY = 'huabu:world-enabled';

let workspaceInitInFlight: Promise<boolean> | null = null;
let spaceTitlesInFlight: {
  promise: Promise<void>;
  overrides: Record<string, string | null>;
  invalidated: Set<string>;
} | null = null;

function resetSpaceTitles() {
  spaceTitlesInFlight = null;
  return {
    spaceTitles: {},
    spaceSummaries: {},
    spaceTitlesStatus: 'idle' as const,
    spaceTitlesError: null,
  };
}

interface WorkspaceState {
  /** Server operating mode. `null` until the first `init()` call. */
  mode: WorkspaceMode | null;
  /** Server-reported capabilities. */
  capabilities: WorkspaceCapabilities | null;

  /** The active absolute workspace path (free mode), or null. */
  workspacePath: string | null;
  /** Stable server-owned Workspace identity, or null before configuration. */
  workspaceId: string | null;
  /** Display label (basename of the active workspace), or null. */
  workspaceName: string | null;
  /** Stable hidden World canvas identity, or null before configuration. */
  worldCanvasId: string | null;
  /** Whether World is exposed as the workspace landing page. */
  worldEnabled: boolean;
  /** Derived ordinary Space titles used by Space Shortcut rendering. */
  spaceTitles: Record<string, string | null>;
  spaceSummaries: Record<string, SpaceSummary | undefined>;
  spaceTitlesStatus: 'idle' | 'loading' | 'ready' | 'error';
  spaceTitlesError: string | null;
  /** Registered free-mode Workspaces (most recently used first). */
  recentWorkspaces: WorkspaceDescriptor[];

  /** Whether a workspace is ready for the app to use. */
  isReady: boolean;
  /** Whether an init/select call is in progress. */
  isSyncing: boolean;
  /** Last sync error, if any. */
  error: string | null;

  /**
   * Number of canvases currently in the active workspace. `null` means
   * "not yet known" (either CanvasListPage hasn't mounted yet, or the
   * workspace just changed and a refetch is pending). Populated by
   * CanvasListPage after each successful `listCanvases()` so that other
   * shells — currently the Electron `WindowChrome` workspace switcher —
   * can surface the same count in their hover tooltip without each
   * caller having to re-fetch the list.
   */
  canvasCount: number | null;

  /**
   * Initialise workspace state on app boot.
   * Returns `true` when a workspace is ready, `false` if free-mode setup
   * is needed (managed mode is always ready after a successful init).
   */
  init: () => Promise<boolean>;

  /** (Free mode) Activate an absolute path. */
  selectWorkspace: (path: string) => Promise<void>;

  /** (Free mode) Activate a registered Workspace by stable identity. */
  activateRecentWorkspace: (workspaceId: string) => Promise<void>;
  /** Create a Workspace by name and switch to it (`namedWorkspaces`). */
  createWorkspace: (name: string) => Promise<void>;
  /** Open a Server folder as one's own Workspace and switch to it (`folderWorkspaces`). */
  openFolderWorkspace: (path: string) => Promise<void>;

  /** (Free mode) Unregister an inactive Workspace. */
  removeRecentWorkspace: (workspaceId: string) => void;

  /**
   * Re-read the Workspace list, for a chooser about to show it: names, roles
   * and Space counts may have changed since the last switch. Keeps the list
   * it has when the read fails.
   */
  refreshWorkspaces: () => Promise<void>;

  /**
   * Rename a Workspace the caller may manage. Updates its chooser row and,
   * when it is the active one, the name shown in the header. Throws on
   * failure so the caller can report it.
   */
  renameWorkspace: (workspaceId: string, name: string) => Promise<void>;

  /**
   * Publish a freshly-counted canvas total. Pass `null` to clear the
   * cached value (e.g. immediately after the workspace changes, before
   * the next list fetch lands).
   */
  setCanvasCount: (count: number | null) => void;
  setWorldEnabled: (enabled: boolean) => void;
  refreshSpaceTitles: (changedCanvasIds?: readonly string[]) => Promise<void>;
  setSpaceTitle: (canvasId: string, title: string | null) => void;
}

/** Apply a fresh WorkspaceInfo snapshot to local state. */
function fromInfo(info: WorkspaceInfo): Partial<WorkspaceState> {
  return {
    mode: info.mode,
    capabilities: info.capabilities,
    workspaceId: info.workspaceId,
    workspacePath: info.path,
    workspaceName: info.name,
    worldCanvasId: info.worldCanvasId,
    ...resetSpaceTitles(),
    isReady: info.configured,
  };
}

/**
 * Notify the rest of the app that a workspace is now active. Dispatched
 * on every transition from "no workspace" / "different workspace" to
 * "ready", including auto-activation from the Workspace registry on boot. Stores
 * gated by the server-side workspace guard (e.g. `acpProfilesStore`,
 * `useDetectedClis`) listen for this to silently re-fetch and drop the
 * cached "Workspace has not been configured" 503 they may have hit
 * before the user picked a folder.
 */
function emitWorkspaceChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event('workspace-changed'));
}

function workspaceActivationError(error: unknown, path: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'WORKSPACE_ACTIVATION_TIMEOUT') {
      const seconds =
        typeof (error.details as { seconds?: unknown } | undefined)?.seconds ===
        'number'
          ? (error.details as { seconds: number }).seconds
          : 70;
      return i18n.t('workspace.activationTimeout', { path, seconds });
    }
    if (error.code === 'WORKSPACE_ACTIVATION_IN_PROGRESS') {
      return i18n.t('workspace.activationInProgress');
    }
  }
  return error instanceof Error
    ? error.message
    : i18n.t('workspace.openPathFailed');
}

/**
 * A Workspace a create made on the Server that never became current (its
 * activation failed), keyed by the name it was created with. Retrying the
 * same name activates it instead of creating a second one. Cleared once any
 * change lands, or when it is removed.
 */
let createdNotActivated: { name: string; workspaceId: string } | null = null;

/**
 * Make another Workspace current.
 *
 * `activate` asks the Server for the change and returns the Workspace it
 * reports as current. `intended` names the Workspace the change is for, once
 * known (a create learns it from the Server); when a request fails but the
 * Server then reports that Workspace as current, the change succeeded and
 * nothing throws. Without `intended` (a folder path), any failure throws.
 *
 * The Workspace list is refreshed after a confirmed change, best-effort: a
 * failed refresh keeps the old list rather than failing a change that landed.
 *
 * Throws, with `error` set, only when the intended Workspace is not current.
 */
async function changeWorkspace(
  activate: () => Promise<WorkspaceInfo>,
  label: string,
  intended?: () => string | undefined,
): Promise<void> {
  const { getState: get, setState: set } = useWorkspaceStore;
  const tabs = getElectronBridge()?.tabs;
  if (tabs) {
    try {
      requireDesktopTabSuccess(await tabs.beginWorkspaceChange());
    } catch (error) {
      set({ error: workspaceActivationError(error, label) });
      throw error;
    }
  }
  set({
    ...resetSpaceTitles(),
    workspaceId: null,
    workspacePath: null,
    workspaceName: null,
    worldCanvasId: null,
    isReady: false,
    isSyncing: true,
    error: null,
    canvasCount: null,
  });
  let confirmed = false;
  let failure: { error: unknown } | null = null;
  try {
    try {
      set(fromInfo(await activate()));
      confirmed = true;
    } catch (error) {
      failure = { error };
      try {
        // A rejected response does not prove that Server activation failed.
        const info = await getWorkspaceInfo();
        set(fromInfo(info));
        confirmed = true;
        if (intended && info.workspaceId === intended()) failure = null;
      } catch (confirmationError) {
        console.error(
          'Could not confirm the active Workspace:',
          confirmationError,
        );
      }
    }
    if (!failure) createdNotActivated = null;
    if (confirmed) {
      try {
        set({ recentWorkspaces: await listWorkspaces() });
      } catch (error) {
        console.warn('Could not refresh the Workspace list:', error);
      }
    }
    if (failure) {
      set({ error: workspaceActivationError(failure.error, label) });
      throw failure.error;
    }
  } finally {
    try {
      if (tabs) requireDesktopTabSuccess(await tabs.endWorkspaceChange());
    } finally {
      set({ isSyncing: false });
    }
    const workspaceId = get().workspaceId;
    if (confirmed && get().isReady && workspaceId) {
      if (tabs)
        requireDesktopTabSuccess(await tabs.workspaceReady(workspaceId));
      emitWorkspaceChanged();
    }
  }
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  mode: null,
  capabilities: null,
  workspacePath: null,
  workspaceId: null,
  workspaceName: null,
  worldCanvasId: null,
  worldEnabled: readApplicationPreference(WORLD_ENABLED_KEY) === 'true',
  spaceTitles: {},
  spaceSummaries: {},
  spaceTitlesStatus: 'idle',
  spaceTitlesError: null,
  recentWorkspaces: [],
  isReady: false,
  isSyncing: false,
  error: null,
  canvasCount: null,

  setWorldEnabled: (worldEnabled) => {
    writeApplicationPreference(WORLD_ENABLED_KEY, String(worldEnabled));
    set({ worldEnabled });
  },
  refreshSpaceTitles: (changedCanvasIds = []) => {
    const { workspaceId, workspacePath, isReady, isSyncing } = get();
    if (!isReady || isSyncing) return Promise.resolve();
    if (changedCanvasIds.length > 0) {
      set((state) => {
        const spaceSummaries = { ...state.spaceSummaries };
        for (const id of changedCanvasIds) {
          const summary = spaceSummaries[id];
          if (summary) {
            const { parentSpaceId, parentEntryNodeId } = summary;
            spaceSummaries[id] = { parentSpaceId, parentEntryNodeId };
          }
        }
        return { spaceSummaries };
      });
    }
    if (spaceTitlesInFlight) {
      for (const id of changedCanvasIds)
        spaceTitlesInFlight.invalidated.add(id);
      return spaceTitlesInFlight.promise;
    }

    const request = {
      promise: Promise.resolve(),
      overrides: {} as Record<string, string | null>,
      invalidated: new Set<string>(),
    };
    const isCurrent = () =>
      spaceTitlesInFlight === request &&
      get().workspaceId === workspaceId &&
      get().workspacePath === workspacePath &&
      !get().isSyncing;
    spaceTitlesInFlight = request;
    request.promise = Promise.resolve()
      .then(() => listCanvases())
      .then(({ canvases }) => {
        if (!isCurrent()) return;
        set({
          canvasCount: canvases.length,
          spaceTitles: {
            ...Object.fromEntries(
              canvases.map((canvas) => [canvas.canvasId, canvas.title]),
            ),
            // An older list must not undo a confirmed local creation or rename.
            ...request.overrides,
          },
          spaceSummaries: {
            ...Object.fromEntries(
              [...request.invalidated].flatMap((id) =>
                get().spaceSummaries[id]
                  ? [[id, get().spaceSummaries[id]]]
                  : [],
              ),
            ),
            ...Object.fromEntries(
              canvases
                .filter((canvas) => !request.invalidated.has(canvas.canvasId))
                .map(
                  ({
                    canvasId,
                    nodeCount,
                    updatedAt,
                    parentSpaceId,
                    parentEntryNodeId,
                  }) => [
                    canvasId,
                    { nodeCount, updatedAt, parentSpaceId, parentEntryNodeId },
                  ],
                ),
            ),
          },
          spaceTitlesStatus: request.invalidated.size ? 'loading' : 'ready',
          spaceTitlesError: null,
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        set({
          spaceTitlesStatus: 'error',
          spaceTitlesError:
            error instanceof Error
              ? error.message
              : i18n.t('spacePreview.targetsUnavailable'),
        });
      })
      .finally(() => {
        const refreshAgain = isCurrent() && request.invalidated.size > 0;
        if (spaceTitlesInFlight === request) spaceTitlesInFlight = null;
        // A mutation during the read needs one trailing request, not stale counts.
        if (refreshAgain) return get().refreshSpaceTitles();
      });
    set({ spaceTitlesStatus: 'loading', spaceTitlesError: null });
    return request.promise;
  },
  setSpaceTitle: (canvasId, title) => {
    if (!get().isReady || get().isSyncing) return;
    if (spaceTitlesInFlight) {
      spaceTitlesInFlight.overrides[canvasId] = title;
    }
    set((state) => ({
      spaceTitles: { ...state.spaceTitles, [canvasId]: title },
    }));
  },

  init: () => {
    workspaceInitInFlight ??= (async () => {
      set({ ...resetSpaceTitles(), isSyncing: true, error: null });

      let info: WorkspaceInfo;
      try {
        info = await getWorkspaceInfo();
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : 'Server unreachable',
          isSyncing: false,
        });
        return false;
      }

      set(fromInfo(info));

      // ── Managed mode: server has already activated; nothing to do. ──
      if (info.mode === 'managed') {
        set({ recentWorkspaces: [], isSyncing: false });
        if (info.configured) emitWorkspaceChanged();
        return info.configured;
      }

      // ── Free mode ──
      // Server already activated (e.g. another tab beat us to it). Where each
      // person has their own Workspaces, the Server has already chosen the
      // caller's current one, which carries no path.
      const activated =
        info.configured &&
        (Boolean(info.path) || info.capabilities.namedWorkspaces === true);

      let registered: WorkspaceDescriptor[] = [];
      try {
        registered = await listWorkspaces();
        set({ recentWorkspaces: registered });
      } catch (err) {
        // Only an owner reads the registry. Anyone else uses the Workspace
        // the Server already has active, whose row may carry no path.
        if (info.configured && err instanceof ApiError && err.status === 403) {
          // Nor may they switch it, whatever the Server's mode allows.
          set({
            isSyncing: false,
            ...(info.capabilities && {
              capabilities: {
                ...info.capabilities,
                canChangeWorkspace: false,
                nativePicker: false,
              },
            }),
          });
          emitWorkspaceChanged();
          return true;
        }
        // A registry we cannot read is only fatal when it is the sole route
        // back to a Workspace. An already-activated Server stays usable; the
        // welcome list is the one thing that degrades.
        if (!activated) {
          set({
            error:
              err instanceof Error ? err.message : 'Failed to list Workspaces',
            isSyncing: false,
          });
          return false;
        }
      }

      if (activated) {
        set({ isSyncing: false });
        emitWorkspaceChanged();
        return true;
      }

      // Restore the most recently used registered Workspace. The registry is
      // authoritative and activation promotes the selected entry to its front.
      // Where each person has their own Workspaces the Server has already
      // picked theirs; having none, they choose. An administrator's registry
      // holds everybody's, and its first entry may be someone else's.
      const saved =
        info.capabilities.namedWorkspaces === true ? undefined : registered[0];
      if (saved) {
        try {
          await activateWorkspace(saved.workspaceId);
          const [next, recent] = await Promise.all([
            getWorkspaceInfo(),
            listWorkspaces(),
          ]);
          set({
            ...fromInfo(next),
            recentWorkspaces: recent,
            isSyncing: false,
          });
          emitWorkspaceChanged();
          return true;
        } catch (err) {
          set({
            workspacePath: null,
            error: workspaceActivationError(err, saved.path ?? saved.name),
          });
        }
      }

      set({ isSyncing: false });
      return false;
    })().finally(() => {
      workspaceInitInFlight = null;
    });

    return workspaceInitInFlight;
  },

  selectWorkspace: async (path: string) => {
    if (get().mode === 'managed') {
      throw new Error('Workspace is locked by the server (managed mode)');
    }
    await changeWorkspace(() => putWorkspacePath(path), path);
  },

  activateRecentWorkspace: async (workspaceId: string) => {
    if (get().mode === 'managed') {
      throw new Error('Workspace is locked by the server (managed mode)');
    }
    const selected = get().recentWorkspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    await changeWorkspace(
      async () => {
        await activateWorkspace(workspaceId);
        return getWorkspaceInfo();
      },
      selected?.path ?? selected?.name ?? workspaceId,
      () => workspaceId,
    );
  },

  createWorkspace: async (name: string) => {
    if (get().mode === 'managed') {
      throw new Error('Workspace is locked by the server (managed mode)');
    }
    // A retry after a failed activation reuses the Workspace already made.
    let workspaceId =
      createdNotActivated?.name === name
        ? createdNotActivated.workspaceId
        : undefined;
    await changeWorkspace(
      async () => {
        if (!workspaceId) {
          workspaceId = (await createNamedWorkspace(name)).workspaceId;
          createdNotActivated = { name, workspaceId };
        }
        await activateWorkspace(workspaceId);
        return getWorkspaceInfo();
      },
      name,
      () => workspaceId,
    );
  },

  openFolderWorkspace: async (path: string) => {
    if (get().mode === 'managed') {
      throw new Error('Workspace is locked by the server (managed mode)');
    }
    let workspaceId: string | undefined;
    await changeWorkspace(
      async () => {
        workspaceId = (await adoptFolderWorkspace(path)).workspaceId;
        await activateWorkspace(workspaceId);
        return getWorkspaceInfo();
      },
      path,
      () => workspaceId,
    );
  },

  removeRecentWorkspace: (workspaceId: string) => {
    if (createdNotActivated?.workspaceId === workspaceId)
      createdNotActivated = null;
    void removeWorkspace(workspaceId)
      .then(() =>
        set((state) => ({
          recentWorkspaces: state.recentWorkspaces.filter(
            (workspace) => workspace.workspaceId !== workspaceId,
          ),
        })),
      )
      .catch(() => {
        // Surface nothing — removing an inactive registration is best-effort.
      });
  },

  refreshWorkspaces: async () => {
    const { workspaceId, recentWorkspaces } = get();
    try {
      const listed = await listWorkspaces();
      // A switch that landed meanwhile has already read its own list, and a
      // rename that landed meanwhile is newer than this answer.
      if (
        get().workspaceId === workspaceId &&
        !get().isSyncing &&
        get().recentWorkspaces === recentWorkspaces
      )
        set({ recentWorkspaces: listed });
    } catch (error) {
      console.warn('Could not refresh the Workspace list:', error);
    }
  },

  renameWorkspace: async (workspaceId: string, name: string) => {
    const renamed = await renameWorkspaceRequest(workspaceId, name);
    set((state) => ({
      recentWorkspaces: state.recentWorkspaces.map((workspace) =>
        workspace.workspaceId === workspaceId
          ? { ...workspace, name: renamed.name }
          : workspace,
      ),
      ...(state.workspaceId === workspaceId
        ? { workspaceName: renamed.name }
        : {}),
    }));
  },

  setCanvasCount: (count: number | null) => {
    if (get().canvasCount === count) return;
    set({ canvasCount: count });
  },
}));

/**
 * Convenience hook: short label for the active workspace, suitable for
 * display in the page header. Returns `null` until a workspace is active.
 *
 * In both modes this is the basename reported by the server. (We also
 * derive it from `workspacePath` as a safety net for the brief moment
 * before the first `GET /workspace` reply lands.)
 */
export function useWorkspaceLabel(): string | null {
  const name = useWorkspaceStore((s) => s.workspaceName);
  const path = useWorkspaceStore((s) => s.workspacePath);
  return useMemo(() => {
    if (name) return name;
    if (path) return path.split(/[\\/]/).filter(Boolean).pop() ?? null;
    return null;
  }, [name, path]);
}

/**
 * Whether the caller may create or import Spaces at the top of the current
 * Workspace. A person given only some of its Spaces may not; servers that do
 * not say so allow it.
 */
export function useCanCreateSpaces(): boolean {
  return useWorkspaceStore((s) => s.capabilities?.canCreateSpaces ?? true);
}

/**
 * Whether the user-facing folder-picker button should be shown.
 *
 * A local Electron shell routes the picker through
 * `dialog.showOpenDialog` (see `apps/web/src/api/workspace.ts`). Remote
 * Electron mode disables it because client paths are meaningless to the
 * Server. In a plain browser the picker still runs on the server, so we
 * defer to `capabilities.nativePicker` (false on headless Linux hosts).
 *
 * Returns `false` while the first capability snapshot is still loading,
 * matching the conservative behaviour of the workspace setup flow.
 */
export function useFolderPickerSupported(): boolean {
  const serverCanPick = useWorkspaceStore(
    (s) => s.capabilities?.nativePicker ?? false,
  );
  return resolveFolderPickerSupported(serverCanPick);
}

export function resolveFolderPickerSupported(
  serverCanPick: boolean,
  bridge: {
    isRemoteServer: boolean;
    dialog?: unknown;
  } | null = getElectronBridge(),
): boolean {
  if (bridge?.isRemoteServer) return false;
  return bridge?.dialog ? true : serverCanPick;
}
