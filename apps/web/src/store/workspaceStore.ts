// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useMemo } from 'react';
import { create } from 'zustand';

import { ApiError } from '../api/_client';
import { listCanvases } from '../api/canvas';
import {
  activateWorkspace,
  getWorkspaceInfo,
  listWorkspaces,
  putWorkspacePath,
  removeWorkspace,
  type WorkspaceCapabilities,
  type WorkspaceDescriptor,
  type WorkspaceInfo,
  type WorkspaceMode,
} from '../api/workspace';
import { getElectronBridge } from '../hooks/useElectron';
import { i18n } from '../i18n';

const WORLD_ENABLED_KEY = 'huabu:world-enabled';

let workspaceInitInFlight: Promise<boolean> | null = null;

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
  /** Derived ordinary Space titles used by World Portal rendering. */
  spaceTitles: Record<string, string | null>;
  spaceTitlesLoaded: boolean;
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

  /** (Free mode) Unregister an inactive Workspace. */
  removeRecentWorkspace: (workspaceId: string) => void;

  /**
   * Publish a freshly-counted canvas total. Pass `null` to clear the
   * cached value (e.g. immediately after the workspace changes, before
   * the next list fetch lands).
   */
  setCanvasCount: (count: number | null) => void;
  setWorldEnabled: (enabled: boolean) => void;
  refreshSpaceTitles: () => Promise<void>;
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
    spaceTitles: {},
    spaceTitlesLoaded: false,
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

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  mode: null,
  capabilities: null,
  workspacePath: null,
  workspaceId: null,
  workspaceName: null,
  worldCanvasId: null,
  worldEnabled:
    typeof localStorage === 'undefined'
      ? false
      : localStorage.getItem(WORLD_ENABLED_KEY) === 'true',
  spaceTitles: {},
  spaceTitlesLoaded: false,
  recentWorkspaces: [],
  isReady: false,
  isSyncing: false,
  error: null,
  canvasCount: null,

  setWorldEnabled: (worldEnabled) => {
    localStorage.setItem(WORLD_ENABLED_KEY, String(worldEnabled));
    set({ worldEnabled });
  },
  refreshSpaceTitles: async () => {
    set({ spaceTitlesLoaded: false });
    const { canvases } = await listCanvases();
    set({
      canvasCount: canvases.length,
      spaceTitles: Object.fromEntries(
        canvases.map((canvas) => [canvas.canvasId, canvas.title]),
      ),
      spaceTitlesLoaded: true,
    });
  },

  init: () => {
    workspaceInitInFlight ??= (async () => {
      set({ isSyncing: true, error: null });

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
      // Server already activated (e.g. another tab beat us to it).
      const activated = info.configured && Boolean(info.path);

      let registered: WorkspaceDescriptor[] = [];
      try {
        registered = await listWorkspaces();
        set({ recentWorkspaces: registered });
      } catch (err) {
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
      const saved = registered[0];
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
    set({ isSyncing: true, error: null, canvasCount: null });
    try {
      const info = await putWorkspacePath(path);
      const recent = await listWorkspaces();
      set({ ...fromInfo(info), recentWorkspaces: recent, isSyncing: false });
      emitWorkspaceChanged();
    } catch (err) {
      const message = workspaceActivationError(err, path);
      set({ error: message, isSyncing: false });
      throw err;
    }
  },

  activateRecentWorkspace: async (workspaceId: string) => {
    if (get().mode === 'managed') {
      throw new Error('Workspace is locked by the server (managed mode)');
    }
    const selected = get().recentWorkspaces.find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    set({ isSyncing: true, error: null, canvasCount: null });
    try {
      await activateWorkspace(workspaceId);
      const [info, recent] = await Promise.all([
        getWorkspaceInfo(),
        listWorkspaces(),
      ]);
      set({ ...fromInfo(info), recentWorkspaces: recent, isSyncing: false });
      emitWorkspaceChanged();
    } catch (err) {
      const message = workspaceActivationError(
        err,
        selected?.path ?? selected?.name ?? workspaceId,
      );
      set({ error: message, isSyncing: false });
      throw err;
    }
  },

  removeRecentWorkspace: (workspaceId: string) => {
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
 * Whether the user-facing folder-picker button should be shown.
 *
 * In the Electron desktop shell we always have a GUI and route the
 * picker through `dialog.showOpenDialog` (see
 * `apps/web/src/api/workspace.ts`), so the answer is unconditionally
 * `true`. In a plain browser the picker still runs on the server, so
 * we defer to the server's `capabilities.nativePicker` capability
 * flag (false on headless Linux hosts).
 *
 * Returns `false` while the first capability snapshot is still loading,
 * matching the conservative behaviour of the workspace setup flow.
 */
export function useFolderPickerSupported(): boolean {
  const serverCanPick = useWorkspaceStore(
    (s) => s.capabilities?.nativePicker ?? false,
  );
  return getElectronBridge()?.dialog ? true : serverCanPick;
}
