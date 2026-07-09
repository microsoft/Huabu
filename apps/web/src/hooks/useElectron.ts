/**
 * Detect whether the renderer is hosted inside the Sediment Electron
 * shell, and access the small set of constants the preload script
 * forwards via `contextBridge.exposeInMainWorld('electronBridge', …)`.
 *
 * In a plain browser (vite dev server, deployed SPA) `window.electronBridge`
 * is simply undefined, and both helpers below report "not Electron".
 *
 * Despite living under `apps/web/src/hooks/`, neither export is a real
 * React hook — they are plain synchronous reads of a global. Naming
 * them `useElectron` / `useIsElectron` previously tricked
 * `react-hooks/rules-of-hooks` and humans into treating them as hooks.
 * They are now `getElectronBridge()` and `isElectron()` to make the
 * non-hook nature obvious; safe to call from anywhere, including
 * outside the render phase.
 */

interface WorkspaceStoreSnapshot {
  path: string | null;
  recent: string[];
}

interface ElectronWorkspaceApi {
  get: () => Promise<WorkspaceStoreSnapshot>;
  set: (path: string) => Promise<WorkspaceStoreSnapshot>;
  removeRecent: (path: string) => Promise<WorkspaceStoreSnapshot>;
}

interface ElectronWindowApi {
  isFullScreen: () => Promise<boolean>;
  onFullScreenChange: (cb: (fullScreen: boolean) => void) => () => void;
}

/**
 * Labels forwarded to the native macOS menu bar. Covers both custom
 * items and standard `role` items — Electron's built-in role labels are
 * English-only and do not track a language switch, so we push explicit
 * localized labels for all of them to keep the menu in the in-app
 * language.
 */
interface ElectronMenuLabels {
  file: string;
  edit: string;
  view: string;
  window: string;
  help: string;
  about: string;
  services: string;
  hide: string;
  hideOthers: string;
  unhide: string;
  quit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  pasteAndMatchStyle: string;
  selectAll: string;
  minimize: string;
  zoom: string;
  front: string;
  close: string;
  toggleFullScreen: string;
  newCanvas: string;
  import: string;
  switchWorkspace: string;
  settings: string;
  userHandbook: string;
  keyboardShortcuts: string;
}

/**
 * Native macOS menu bar bridge. On macOS the workspace-level actions
 * live in the OS menu bar (platform convention) rather than the in-app
 * `AppMenu` dropdown; both surfaces reuse the same renderer handlers.
 * On Windows / Linux these calls are harmless no-ops — there is no
 * native menu bar and the title-bar dropdown stays the entry point.
 */
interface ElectronMenuApi {
  /**
   * Push localized labels + capability flags to the main process so it
   * can (re)build the menu bar. Call on mount and whenever the language
   * or `canChangeWorkspace` capability changes.
   */
  configure: (config: {
    labels: ElectronMenuLabels;
    canChangeWorkspace: boolean;
  }) => void;
  /**
   * Subscribe to native menu-item activations; returns an unsubscribe
   * function. Command ids: 'new-canvas' | 'import-canvas' |
   * 'switch-workspace' | 'open-settings' | 'open-handbook' |
   * 'open-shortcuts'.
   */
  onCommand: (cb: (command: string) => void) => () => void;
}

/**
 * Native OS dialogs forwarded from the Electron main process.
 *
 * `pickFolder` swaps the server's legacy PowerShell folder picker for
 * Electron's `dialog.showOpenDialog({ properties: ['openDirectory'] })`,
 * which uses the modern Vista+ IFileOpenDialog on Windows (Explorer
 * sidebar + path bar + "New folder" button) and NSOpenPanel on macOS.
 *
 * The result shape mirrors `PickFolderResult` from `@sediment/shared`
 * minus the `'no-picker'` reason — Electron always has a GUI, so only
 * `'cancelled'` is possible on the non-`ok` branch.
 */
interface ElectronDialogApi {
  pickFolder: (
    title?: string,
  ) => Promise<{ ok: true; path: string } | { ok: false; reason: 'cancelled' }>;
}

interface ElectronBridge {
  versions: {
    node: string;
    chrome: string;
    electron: string;
  };
  isElectron: true;
  /** Forwarded `process.platform` value: 'win32' | 'darwin' | 'linux' | ... */
  platform: NodeJS.Platform;
  /**
   * Height (CSS pixels) of the HTML title bar strip. Forwarded from
   * the main process's `TITLE_BAR_HEIGHT` constant so the renderer's
   * `WindowChrome` can size itself without re-declaring the magic
   * number. Always present when the bridge itself is present.
   */
  titleBarHeight: number;
  /**
   * Port-agnostic workspace persistence backed by a JSON file under
   * `app.getPath('userData')` in the main process. Use this in
   * preference to `localStorage` when present: Electron's renderer
   * partitions storage by origin (scheme + host + port), and the
   * shell's server port can change between launches, which would
   * otherwise reset the saved workspace.
   */
  workspace?: ElectronWorkspaceApi;
  window?: ElectronWindowApi;
  dialog?: ElectronDialogApi;
  menu?: ElectronMenuApi;
}

declare global {
  interface Window {
    electronBridge?: ElectronBridge;
  }
}

/**
 * Returns the Electron bridge if present, or `null` in the browser.
 * Plain function — not a React hook. Safe to call from event
 * handlers, module top-level, render bodies, etc.
 */
export function getElectronBridge(): ElectronBridge | null {
  if (typeof window === 'undefined') return null;
  return window.electronBridge ?? null;
}

/**
 * Shorthand boolean for the most common check. Equivalent to
 * `getElectronBridge() !== null`. Plain function — not a React hook.
 */
export function isElectron(): boolean {
  return getElectronBridge() !== null;
}
