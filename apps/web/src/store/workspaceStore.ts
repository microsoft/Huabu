import { useMemo } from 'react';
import { create } from 'zustand';

import {
  getWorkspaceInfo,
  putWorkspacePath,
  type WorkspaceCapabilities,
  type WorkspaceInfo,
  type WorkspaceMode,
} from '../api/workspace';

const FREE_PATH_KEY = 'sediment:workspace-path';
const RECENT_PATHS_KEY = 'sediment:recent-workspaces';
const MAX_RECENT = 5;

/** Read recent free-mode workspace paths from localStorage. */
function loadRecentWorkspaces(): string[] {
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

/** Persist a path to the free-mode recent list (most recent first, deduped). */
function pushRecentWorkspace(path: string): string[] {
  const list = loadRecentWorkspaces().filter((p) => p !== path);
  list.unshift(path);
  const trimmed = list.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(trimmed));
  return trimmed;
}

interface WorkspaceState {
  /** Server operating mode. `null` until the first `init()` call. */
  mode: WorkspaceMode | null;
  /** Server-reported capabilities. */
  capabilities: WorkspaceCapabilities | null;

  /** The active absolute workspace path (free mode), or null. */
  workspacePath: string | null;
  /** Display label (basename of the active workspace), or null. */
  workspaceName: string | null;
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
}

/** Apply a fresh WorkspaceInfo snapshot to local state. */
function fromInfo(info: WorkspaceInfo): Partial<WorkspaceState> {
  return {
    mode: info.mode,
    capabilities: info.capabilities,
    workspacePath: info.path,
    workspaceName: info.name,
    isReady: info.configured,
  };
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  mode: null,
  capabilities: null,
  workspacePath: localStorage.getItem(FREE_PATH_KEY),
  workspaceName: null,
  recentWorkspaces: loadRecentWorkspaces(),
  isReady: false,
  isSyncing: false,
  error: null,
  canvasCount: null,

  init: async () => {
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
      // Free-mode leftovers are meaningless here.
      localStorage.removeItem(FREE_PATH_KEY);
      set({ isSyncing: false });
      return info.configured;
    }

    // ── Free mode ──
    // Server already activated (e.g. another tab beat us to it).
    if (info.configured && info.path) {
      localStorage.setItem(FREE_PATH_KEY, info.path);
      const recent = pushRecentWorkspace(info.path);
      set({ recentWorkspaces: recent, isSyncing: false });
      return true;
    }

    // Try to auto-activate using a remembered absolute path.
    const savedPath = localStorage.getItem(FREE_PATH_KEY);
    if (savedPath) {
      try {
        const next = await putWorkspacePath(savedPath);
        const recent = pushRecentWorkspace(savedPath);
        set({
          ...fromInfo(next),
          recentWorkspaces: recent,
          isSyncing: false,
        });
        return true;
      } catch (err) {
        // Stored path is invalid (e.g. cross-platform leftover). Drop it
        // and fall through to setup so the user picks a fresh one.
        localStorage.removeItem(FREE_PATH_KEY);
        set({
          error:
            err instanceof Error
              ? `Saved workspace is no longer valid: ${err.message}`
              : 'Saved workspace is no longer valid',
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
      localStorage.setItem(FREE_PATH_KEY, path);
      const recent = pushRecentWorkspace(path);
      set({ ...fromInfo(info), recentWorkspaces: recent, isSyncing: false });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update workspace';
      set({ error: message, isSyncing: false });
      throw err;
    }
  },

  removeRecentWorkspace: (path: string) => {
    const list = loadRecentWorkspaces().filter((p) => p !== path);
    localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(list));
    set({ recentWorkspaces: list });
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
