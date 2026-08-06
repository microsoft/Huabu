// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useMemo } from 'react';
import { create } from 'zustand';

import { ApiError } from '../api/_client';
import { listCanvases } from '../api/canvas';
import {
  getWorkspaceInfo,
  putWorkspacePath,
  type WorkspaceCapabilities,
  type WorkspaceInfo,
  type WorkspaceMode,
} from '../api/workspace';
import { getElectronBridge } from '../hooks/useElectron';
import { i18n } from '../i18n';

const FREE_PATH_KEY = 'sediment:workspace-path';
const RECENT_PATHS_KEY = 'sediment:recent-workspaces';
const MAX_RECENT = 5;
const WORLD_ENABLED_KEY = 'sediment:world-enabled';

/**
 * Storage backend abstraction. In Electron we delegate to the main
 * process (file under `userData/workspace.json`) so the saved
 * workspace survives the renderer's per-origin localStorage being
 * wiped whenever the shell picks a different server port. In the
 * browser / Vite dev server we fall back to `localStorage`.
 *
 * Implementations mirror each other shape-wise so the caller doesn't
 * have to branch on the environment.
 */
interface WorkspacePersistence {
  load: () => Promise<{ path: string | null; recent: string[] }>;
  save: (path: string) => Promise<string[]>;
  remove: (path: string) => Promise<string[]>;
}

function loadLocalStorageRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PATHS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    // ignore corrupt JSON
  }
  return [];
}

function pushLocalStorageRecent(path: string): string[] {
  const list = loadLocalStorageRecents().filter((p) => p !== path);
  list.unshift(path);
  const trimmed = list.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(trimmed));
  return trimmed;
}

const localStoragePersistence: WorkspacePersistence = {
  load: async () => ({
    path: localStorage.getItem(FREE_PATH_KEY),
    recent: loadLocalStorageRecents(),
  }),
  save: async (path: string) => {
    localStorage.setItem(FREE_PATH_KEY, path);
    return pushLocalStorageRecent(path);
  },
  remove: async (path: string) => {
    const list = loadLocalStorageRecents().filter((p) => p !== path);
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(list));
    if (localStorage.getItem(FREE_PATH_KEY) === path) {
      localStorage.removeItem(FREE_PATH_KEY);
    }
    return list;
  },
};

/**
 * Build the Electron-backed persistence, migrating any pre-existing
 * `localStorage` values into the main-process store on first read so
 * users upgrading from a previous build don't lose their selection.
 */
interface ElectronWorkspaceLike {
  get: () => Promise<{ path: string | null; recent: string[] }>;
  set: (path: string) => Promise<{ path: string | null; recent: string[] }>;
  removeRecent: (
    path: string,
  ) => Promise<{ path: string | null; recent: string[] }>;
}

function makeElectronPersistence(
  api: ElectronWorkspaceLike,
): WorkspacePersistence {
  return {
    load: async () => {
      const snap = await api.get();
      // One-shot migration: if the main-process file is empty but the
      // renderer still has a localStorage value (from an older build
      // that only used localStorage), promote it so the user keeps
      // their workspace across this upgrade. We only migrate the
      // active path — stale recents from a different port partition
      // aren't worth preserving.
      if (!snap.path) {
        const legacyPath = localStorage.getItem(FREE_PATH_KEY);
        if (legacyPath) {
          return await api.set(legacyPath);
        }
      }
      return snap;
    },
    save: async (path: string) => {
      const snap = await api.set(path);
      return snap.recent;
    },
    remove: async (path: string) => {
      const snap = await api.removeRecent(path);
      return snap.recent;
    },
  };
}

function getPersistence(): WorkspacePersistence {
  const bridge = getElectronBridge();
  if (bridge?.workspace) {
    return makeElectronPersistence(bridge.workspace);
  }
  return localStoragePersistence;
}

const persistence = getPersistence();

interface WorkspaceState {
  /** Server operating mode. `null` until the first `init()` call. */
  mode: WorkspaceMode | null;
  /** Server-reported capabilities. */
  capabilities: WorkspaceCapabilities | null;

  /** The active absolute workspace path (free mode), or null. */
  workspacePath: string | null;
  /** Display label (basename of the active workspace), or null. */
  workspaceName: string | null;
  /** Stable hidden World canvas identity, or null before configuration. */
  worldCanvasId: string | null;
  /** Whether World is exposed as the workspace landing page. */
  worldEnabled: boolean;
  /** Derived ordinary Space titles used by World Portal rendering. */
  spaceTitles: Record<string, string | null>;
  spaceTitlesLoaded: boolean;
  /** Recently used free-mode paths (most recent first). */
  recentWorkspaces: string[];

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

  /** (Free mode) Remove a path from the recent list. */
  removeRecentWorkspace: (path: string) => void;

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
 * "ready", including auto-activation from a saved path on boot. Stores
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
  // Synchronous bootstrap value so first paint doesn't flicker the
  // setup page when localStorage already holds something. The async
  // `init()` call refreshes both fields from the authoritative
  // persistence (Electron file or localStorage) immediately after.
  workspacePath:
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(FREE_PATH_KEY)
      : null,
  workspaceName: null,
  worldCanvasId: null,
  worldEnabled:
    typeof localStorage === 'undefined'
      ? false
      : localStorage.getItem(WORLD_ENABLED_KEY) === 'true',
  spaceTitles: {},
  spaceTitlesLoaded: false,
  recentWorkspaces:
    typeof localStorage !== 'undefined' ? loadLocalStorageRecents() : [],
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

  init: async () => {
    set({ isSyncing: true, error: null });

    // Pull the persisted snapshot up-front so we have an authoritative
    // value regardless of whether we're using the Electron-backed
    // store or plain localStorage. Doing this BEFORE the server call
    // also lets us refresh the synchronous bootstrap value if the
    // Electron file disagrees with localStorage.
    const persisted = await persistence.load().catch(() => ({
      path: null as string | null,
      recent: [] as string[],
    }));
    set({
      workspacePath: persisted.path,
      recentWorkspaces: persisted.recent,
    });

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
      // Free-mode leftovers are meaningless here.
      try {
        await persistence.remove(persisted.path ?? '');
      } catch {
        // best-effort cleanup
      }
      localStorage.removeItem(FREE_PATH_KEY);
      set({ isSyncing: false });
      if (info.configured) emitWorkspaceChanged();
      return info.configured;
    }

    // ── Free mode ──
    // Server already activated (e.g. another tab beat us to it).
    if (info.configured && info.path) {
      const recent = await persistence.save(info.path);
      set({ recentWorkspaces: recent, isSyncing: false });
      emitWorkspaceChanged();
      return true;
    }

    // Try to auto-activate using the remembered absolute path.
    const savedPath = persisted.path;
    if (savedPath) {
      try {
        const next = await putWorkspacePath(savedPath);
        const recent = await persistence.save(savedPath);
        set({
          ...fromInfo(next),
          recentWorkspaces: recent,
          isSyncing: false,
        });
        emitWorkspaceChanged();
        return true;
      } catch (err) {
        // Stored path is invalid (e.g. cross-platform leftover). Drop it
        // and fall through to setup so the user picks a fresh one.
        try {
          await persistence.remove(savedPath);
        } catch {
          // best-effort cleanup
        }
        set({
          workspacePath: null,
          error: workspaceActivationError(err, savedPath),
        });
      }
    }

    set({ isSyncing: false });
    return false;
  },

  selectWorkspace: async (path: string) => {
    if (get().mode === 'managed') {
      throw new Error('Workspace is locked by the server (managed mode)');
    }
    set({ isSyncing: true, error: null, canvasCount: null });
    try {
      const info = await putWorkspacePath(path);
      const recent = await persistence.save(path);
      set({ ...fromInfo(info), recentWorkspaces: recent, isSyncing: false });
      emitWorkspaceChanged();
    } catch (err) {
      const message = workspaceActivationError(err, path);
      set({ error: message, isSyncing: false });
      throw err;
    }
  },

  removeRecentWorkspace: (path: string) => {
    void persistence
      .remove(path)
      .then((list) => set({ recentWorkspaces: list }))
      .catch(() => {
        // Surface nothing — the recents list is best-effort UX.
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
