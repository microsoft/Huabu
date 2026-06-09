/**
 * Preload script — runs in an isolated context with access to both
 * the DOM and a limited set of Node.js APIs.
 *
 * We keep this minimal: only version information and a handful of
 * runtime constants (`platform`, `titleBarHeight`) are exposed via
 * contextBridge. All application logic goes through the HTTP API
 * (the BrowserWindow loads http://127.0.0.1:<port>), so there is
 * no need to bridge Node.js or Electron APIs into the renderer.
 *
 * Compatible with `webPreferences.sandbox: true` — only touches
 * `contextBridge`, `process.versions` and `process.platform`, all
 * of which are available inside the renderer sandbox.
 *
 * ⚠️ Sandbox constraint: Electron's sandboxed preload uses a
 * polyfilled `require` that ONLY resolves a tiny allowlist of
 * built-in modules (`events`, `timers`, `url`, and a limited
 * `electron`). It cannot `require('./local-file.js')`. That's
 * why `TITLE_BAR_HEIGHT` is duplicated here as a literal instead
 * of imported from `./title-bar.ts` — importing a sibling module
 * crashes preload with "module not found" and silently kills the
 * `contextBridge` exposure, breaking every Electron-only UI bit.
 *
 * If you change the value below, **also update**
 * `apps/desktop/src/title-bar.ts` to match — main.ts feeds that
 * constant to Electron's `titleBarOverlay.height`, and the two
 * must stay pixel-aligned or the OS-drawn caption buttons will
 * float over (or below) the HTML strip.
 */

import { contextBridge, ipcRenderer } from 'electron';

/**
 * Height (CSS pixels) of the HTML title bar strip. MUST match
 * `TITLE_BAR_HEIGHT` in `./title-bar.ts` — see header comment.
 */
const TITLE_BAR_HEIGHT = 36;

interface WorkspaceStoreSnapshot {
  path: string | null;
  recent: string[];
}

contextBridge.exposeInMainWorld('electronBridge', {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  /** Flag for the web app to detect it is running inside Electron. */
  isElectron: true,
  /**
   * `process.platform` value forwarded to the renderer. Used by the
   * custom title bar (`WindowChrome`) to leave a left-side gutter on
   * macOS for the traffic-light buttons.
   */
  platform: process.platform,
  /**
   * Height (CSS pixels) of the HTML title bar strip. Sourced from the
   * same `title-bar.ts` constant that the main process feeds to
   * Electron's `titleBarOverlay.height`, so the renderer can size its
   * `WindowChrome` element identically without re-declaring the magic
   * number on its own side.
   */
  titleBarHeight: TITLE_BAR_HEIGHT,
  /**
   * Port-agnostic workspace persistence. The main process writes the
   * selected free-mode workspace path (and its recents list) into
   * `<userData>/workspace.json`, sidestepping the per-origin
   * `localStorage` bucket that resets whenever Electron has to pick a
   * fresh server port. See `main.ts` → "Workspace persistence" for
   * the full rationale.
   */
  workspace: {
    get: (): Promise<WorkspaceStoreSnapshot> =>
      ipcRenderer.invoke('workspace:get') as Promise<WorkspaceStoreSnapshot>,
    set: (path: string): Promise<WorkspaceStoreSnapshot> =>
      ipcRenderer.invoke(
        'workspace:set',
        path,
      ) as Promise<WorkspaceStoreSnapshot>,
    removeRecent: (path: string): Promise<WorkspaceStoreSnapshot> =>
      ipcRenderer.invoke(
        'workspace:remove-recent',
        path,
      ) as Promise<WorkspaceStoreSnapshot>,
  },

  window: {
    isFullScreen: (): Promise<boolean> =>
      ipcRenderer.invoke('window:is-fullscreen') as Promise<boolean>,
    onFullScreenChange: (cb: (fullScreen: boolean) => void): (() => void) => {
      const listener = (_event: unknown, fullScreen: boolean): void => {
        cb(fullScreen);
      };
      ipcRenderer.on('window:fullscreen', listener);
      return () => {
        ipcRenderer.removeListener('window:fullscreen', listener);
      };
    },
  },
});
