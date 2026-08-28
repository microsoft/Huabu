// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

  diagnostics: {
    openServerLog: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('diagnostics:open-server-log') as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    openDeveloperTools: (): Promise<
      { ok: true } | { ok: false; error: string }
    > =>
      ipcRenderer.invoke('diagnostics:open-developer-tools') as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    getSystemInfo: (): Promise<{
      appVersion: string;
      platform: NodeJS.Platform;
      osRelease: string;
      architecture: string;
      electronVersion: string;
    }> =>
      ipcRenderer.invoke('diagnostics:get-system-info') as Promise<{
        appVersion: string;
        platform: NodeJS.Platform;
        osRelease: string;
        architecture: string;
        electronVersion: string;
      }>,
  },

  /**
   * Native macOS menu bar bridge. `configure` pushes localized labels +
   * capability flags to the main process so it can (re)build the menu in
   * the in-app language; `onCommand` subscribes to menu-item activations
   * so the renderer can dispatch them onto the same handlers that back
   * the in-app `AppMenu`. No-op on Windows / Linux (no native menu bar).
   */
  menu: {
    configure: (config: unknown): void => {
      ipcRenderer.send('menu:configure', config);
    },
    onCommand: (cb: (command: string) => void): (() => void) => {
      const listener = (_event: unknown, command: string): void => {
        cb(command);
      };
      ipcRenderer.on('menu:command', listener);
      return () => {
        ipcRenderer.removeListener('menu:command', listener);
      };
    },
  },

  /**
   * Native OS dialogs forwarded from the main process. Currently only
   * `pickFolder` is exposed — used by Settings panels and the
   * workspace setup flow to swap the server's legacy PowerShell
   * `FolderBrowserDialog` for Electron's modern `openDirectory`
   * dialog (IFileOpenDialog on Windows, NSOpenPanel on macOS).
   */
  dialog: {
    pickFolder: (
      title?: string,
    ): Promise<
      { ok: true; path: string } | { ok: false; reason: 'cancelled' }
    > =>
      ipcRenderer.invoke('dialog:pick-folder', title) as Promise<
        { ok: true; path: string } | { ok: false; reason: 'cancelled' }
      >,
  },

  /**
   * Auto-update bridge (electron-updater). Real update operations only
   * work in the packaged app; unpackaged dev runs return an unavailable
   * result instead of throwing. The main process drives the check →
   * download → install lifecycle and pushes every transition over
   * `update:status`; `getState` returns the latest snapshot so a
   * freshly-mounted renderer can sync immediately. The `check` /
   * `download` / `install` actions map onto explicit user intent —
   * nothing downloads or restarts without a click.
   */
  updater: {
    check: (): Promise<
      { ok: true; status: unknown } | { ok: false; error: string }
    > =>
      ipcRenderer.invoke('update:check') as Promise<
        { ok: true; status: unknown } | { ok: false; error: string }
      >,
    download: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('update:download') as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    install: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('update:install') as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    getState: (): Promise<unknown> =>
      ipcRenderer.invoke('update:get-state') as Promise<unknown>,
    onStatus: (cb: (status: unknown) => void): (() => void) => {
      const listener = (_event: unknown, status: unknown): void => {
        cb(status);
      };
      ipcRenderer.on('update:status', listener);
      return () => {
        ipcRenderer.removeListener('update:status', listener);
      };
    },
  },
});
