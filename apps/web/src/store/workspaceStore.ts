import { create } from 'zustand';

import { getWorkspacePath, putWorkspacePath } from '../api/workspace';

const STORAGE_KEY = 'sediment:workspace-path';
const RECENT_KEY = 'sediment:recent-workspaces';
const MAX_RECENT = 5;

/** Read recent workspace paths from localStorage. */
function loadRecentWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed.filter((p) => typeof p === 'string');
  } catch {
    // Corrupted data – ignore
  }
  return [];
}

/** Persist a workspace path to the recent list (most recent first, deduplicated). */
function pushRecentWorkspace(path: string): string[] {
  const list = loadRecentWorkspaces().filter((p) => p !== path);
  list.unshift(path);
  const trimmed = list.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed));
  return trimmed;
}

interface WorkspaceState {
  /** The workspace folder path, or null if not yet configured. */
  workspacePath: string | null;
  /** Whether the workspace has been synced to the server this session. */
  isReady: boolean;
  /** Whether the initial sync is in progress. */
  isSyncing: boolean;
  /** Error from the last sync attempt. */
  error: string | null;
  /** Recently used workspace paths (most recent first). */
  recentWorkspaces: string[];

  /**
   * Initialise workspace on app boot.
   * 1. If localStorage has a saved path → push it to the server.
   * 2. Otherwise ask the server if a path was already configured
   *    (e.g. by another tab).
   * Returns `true` when a workspace is ready, `false` if setup is needed.
   */
  init: () => Promise<boolean>;

  /**
   * Set the workspace path (picked by user), persist to localStorage,
   * and push to the server.
   */
  selectWorkspace: (path: string) => Promise<void>;

  /** Remove a path from the recent workspaces list. */
  removeRecentWorkspace: (path: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  workspacePath: localStorage.getItem(STORAGE_KEY),
  isReady: false,
  isSyncing: false,
  error: null,
  recentWorkspaces: loadRecentWorkspaces(),

  init: async () => {
    const saved = localStorage.getItem(STORAGE_KEY);

    // Fast path: localStorage has a path → sync it to the server
    if (saved) {
      set({ isSyncing: true, error: null });
      try {
        await putWorkspacePath(saved);
        const recent = pushRecentWorkspace(saved);
        set({
          workspacePath: saved,
          isReady: true,
          isSyncing: false,
          recentWorkspaces: recent,
        });
        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to sync workspace';
        set({ error: message, isSyncing: false });
        return false;
      }
    }

    // Slow path: check if the server already has a configured workspace
    try {
      const info = await getWorkspacePath();
      if (info.configured && info.path) {
        localStorage.setItem(STORAGE_KEY, info.path);
        const recent = pushRecentWorkspace(info.path);
        set({
          workspacePath: info.path,
          isReady: true,
          isSyncing: false,
          recentWorkspaces: recent,
        });
        return true;
      }
    } catch {
      // Server unreachable — fall through to setup
    }

    set({ isReady: false, isSyncing: false });
    return false;
  },

  selectWorkspace: async (path: string) => {
    set({ isSyncing: true, error: null });
    try {
      await putWorkspacePath(path);
      localStorage.setItem(STORAGE_KEY, path);
      const recent = pushRecentWorkspace(path);
      set({
        workspacePath: path,
        isReady: true,
        isSyncing: false,
        recentWorkspaces: recent,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to set workspace';
      set({ error: message, isSyncing: false });
      throw err;
    }
  },

  removeRecentWorkspace: (path: string) => {
    const list = loadRecentWorkspaces().filter((p) => p !== path);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    set({ recentWorkspaces: list });
  },
}));
