// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Native application menu (macOS).
 *
 * Platform convention split: macOS expects workspace-level actions
 * to live in the
 * global menu bar at the top of the screen, NOT in a logo dropdown
 * crammed next to the traffic-lights. Windows / Linux have no global
 * menu bar, so there the in-app `AppMenu` dropdown in the custom title
 * bar remains the sole entry point (`Menu.setApplicationMenu(null)`).
 *
 * The menu is built here in the main process but its labels come from
 * the renderer's i18n (pushed via `menu:configure`) so the native menu
 * matches the in-app language. Menu items dispatch IPC commands the
 * renderer maps back onto the same handlers that back the `AppMenu`
 * dropdown, so there is a single source of truth for the behaviour.
 *
 * This module owns all macOS-menu concerns; `main.ts` only wires it up
 * by handing over a getter for the current `BrowserWindow`. Off macOS,
 * every exported entry point degrades to clearing the application menu.
 */

import { app, BrowserWindow, ipcMain, Menu } from 'electron';

/**
 * Resolver for the current main window, injected by `main.ts`. Menu
 * click handlers target the focused window first and fall back to this,
 * so multi-window setups still route commands to a live renderer.
 */
let getMainWindow: () => BrowserWindow | null = () => null;

/**
 * Labels for the macOS menu bar, sourced from the renderer's i18n so
 * the whole menu — including the standard editing / window / app items —
 * follows the in-app language rather than the OS language. Electron's
 * built-in `role` labels are English-only and do NOT track a language
 * change, so we pass an explicit `label` for every role item too. The
 * only items left to macOS are the ones the OS injects itself (Dictation,
 * Emoji & Symbols, the Services list, the live window list) — those stay
 * in the OS language and are outside our control.
 */
interface MenuLabels {
  // Top-level submenu titles.
  file: string;
  edit: string;
  view: string;
  window: string;
  help: string;
  // App menu (role items). `about` / `hide` / `quit` already include the
  // interpolated app name from the renderer.
  about: string;
  services: string;
  hide: string;
  hideOthers: string;
  unhide: string;
  quit: string;
  // Edit menu (role items).
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  pasteAndMatchStyle: string;
  selectAll: string;
  // Window menu (role items).
  minimize: string;
  zoom: string;
  front: string;
  close: string;
  // View menu (role item).
  toggleFullScreen: string;
  // Custom (IPC-dispatched) workspace actions.
  newCanvas: string;
  import: string;
  switchWorkspace: string;
  settings: string;
  checkForUpdates: string;
  userHandbook: string;
  keyboardShortcuts: string;
  troubleshooting: string;
  openServerLog: string;
  openDeveloperTools: string;
  copySystemInfo: string;
}

interface MenuConfig {
  labels: MenuLabels;
  canChangeWorkspace: boolean;
  canCheckForUpdates: boolean;
}

/**
 * English fallback used to build the menu at startup, before the
 * renderer has pushed localized labels. Keeps the standard Edit / Window
 * accelerators and ⌘, / ⌘N working from the first frame.
 */
const DEFAULT_MENU_CONFIG: MenuConfig = {
  labels: {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    about: `About ${app.getName()}`,
    services: 'Services',
    hide: `Hide ${app.getName()}`,
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: `Quit ${app.getName()}`,
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    selectAll: 'Select All',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    close: 'Close Window',
    toggleFullScreen: 'Toggle Full Screen',
    newCanvas: 'New Space',
    import: 'Import',
    switchWorkspace: 'Switch Home',
    settings: 'Settings',
    checkForUpdates: 'Check for Updates',
    userHandbook: 'User Handbook',
    keyboardShortcuts: 'Keyboard Shortcuts',
    troubleshooting: 'Troubleshooting',
    openServerLog: 'Open Server Log',
    openDeveloperTools: 'Open Developer Tools',
    copySystemInfo: 'Copy System Information',
  },
  canChangeWorkspace: true,
  canCheckForUpdates: true,
};

/**
 * Forward a menu-item activation to the renderer, where the same
 * handlers that back the in-app `AppMenu` dropdown live. Targets the
 * focused window so multi-window setups route to the right renderer.
 */
function sendMenuCommand(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? getMainWindow();
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send('menu:command', command);
  }
}

/**
 * Coerce the untrusted `menu:configure` payload into a `MenuConfig`,
 * falling back to the English defaults for any missing / malformed field
 * so a bad message can never crash menu construction.
 */
function normalizeMenuConfig(raw: unknown): MenuConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_MENU_CONFIG;
  const obj = raw as Record<string, unknown>;
  const rawLabels =
    typeof obj.labels === 'object' && obj.labels !== null
      ? (obj.labels as Record<string, unknown>)
      : {};
  const pick = (key: keyof MenuLabels): string => {
    const value = rawLabels[key];
    return typeof value === 'string' && value.length > 0
      ? value
      : DEFAULT_MENU_CONFIG.labels[key];
  };
  return {
    labels: {
      file: pick('file'),
      edit: pick('edit'),
      view: pick('view'),
      window: pick('window'),
      help: pick('help'),
      about: pick('about'),
      services: pick('services'),
      hide: pick('hide'),
      hideOthers: pick('hideOthers'),
      unhide: pick('unhide'),
      quit: pick('quit'),
      undo: pick('undo'),
      redo: pick('redo'),
      cut: pick('cut'),
      copy: pick('copy'),
      paste: pick('paste'),
      pasteAndMatchStyle: pick('pasteAndMatchStyle'),
      selectAll: pick('selectAll'),
      minimize: pick('minimize'),
      zoom: pick('zoom'),
      front: pick('front'),
      close: pick('close'),
      toggleFullScreen: pick('toggleFullScreen'),
      newCanvas: pick('newCanvas'),
      import: pick('import'),
      switchWorkspace: pick('switchWorkspace'),
      settings: pick('settings'),
      checkForUpdates: pick('checkForUpdates'),
      userHandbook: pick('userHandbook'),
      keyboardShortcuts: pick('keyboardShortcuts'),
      troubleshooting: pick('troubleshooting'),
      openServerLog: pick('openServerLog'),
      openDeveloperTools: pick('openDeveloperTools'),
      copySystemInfo: pick('copySystemInfo'),
    },
    canChangeWorkspace:
      typeof obj.canChangeWorkspace === 'boolean'
        ? obj.canChangeWorkspace
        : true,
    canCheckForUpdates:
      typeof obj.canCheckForUpdates === 'boolean'
        ? obj.canCheckForUpdates
        : true,
  };
}

/**
 * Build the macOS menu-bar template. Standard editing / window items use
 * Electron `role`s for their behaviour + accelerators, but carry an
 * explicit localized `label` so the whole menu follows the in-app
 * language (Electron's default role labels are English-only). Workspace
 * actions dispatch IPC commands the renderer maps onto its existing
 * handlers. Keyboard-shortcut help carries no accelerator here because
 * the renderer already owns the global `?` hotkey — binding it twice
 * would toggle the modal open then closed on a single press.
 */
function buildMacMenu(config: MenuConfig): Menu {
  const { labels, canChangeWorkspace, canCheckForUpdates } = config;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      // The first submenu is always treated as the app menu by macOS
      // and titled with the app name automatically.
      label: app.getName(),
      submenu: [
        { role: 'about', label: labels.about },
        {
          label: labels.checkForUpdates,
          enabled: canCheckForUpdates,
          click: () => sendMenuCommand('check-for-updates'),
        },
        { type: 'separator' },
        {
          label: labels.settings,
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuCommand('open-settings'),
        },
        { type: 'separator' },
        { role: 'services', label: labels.services },
        { type: 'separator' },
        { role: 'hide', label: labels.hide },
        { role: 'hideOthers', label: labels.hideOthers },
        { role: 'unhide', label: labels.unhide },
        { type: 'separator' },
        { role: 'quit', label: labels.quit },
      ],
    },
    {
      label: labels.file,
      submenu: [
        {
          label: labels.newCanvas,
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuCommand('new-canvas'),
        },
        {
          label: labels.import,
          click: () => sendMenuCommand('import-canvas'),
        },
        ...(canChangeWorkspace
          ? [
              { type: 'separator' as const },
              {
                label: labels.switchWorkspace,
                click: () => sendMenuCommand('switch-workspace'),
              },
            ]
          : []),
        { type: 'separator' },
        { role: 'close', label: labels.close },
      ],
    },
    {
      label: labels.edit,
      submenu: [
        { role: 'undo', label: labels.undo },
        { role: 'redo', label: labels.redo },
        { type: 'separator' },
        { role: 'cut', label: labels.cut },
        { role: 'copy', label: labels.copy },
        { role: 'paste', label: labels.paste },
        { role: 'pasteAndMatchStyle', label: labels.pasteAndMatchStyle },
        { role: 'selectAll', label: labels.selectAll },
      ],
    },
    {
      label: labels.view,
      submenu: [{ role: 'togglefullscreen', label: labels.toggleFullScreen }],
    },
    {
      label: labels.window,
      submenu: [
        { role: 'minimize', label: labels.minimize },
        { role: 'zoom', label: labels.zoom },
        { type: 'separator' },
        { role: 'front', label: labels.front },
      ],
    },
    {
      label: labels.help,
      submenu: [
        {
          label: labels.userHandbook,
          click: () => sendMenuCommand('open-handbook'),
        },
        {
          label: labels.keyboardShortcuts,
          click: () => sendMenuCommand('open-shortcuts'),
        },
        { type: 'separator' },
        {
          label: labels.troubleshooting,
          submenu: [
            {
              label: labels.openServerLog,
              click: () => sendMenuCommand('open-server-log'),
            },
            {
              label: labels.openDeveloperTools,
              click: () => sendMenuCommand('open-developer-tools'),
            },
            {
              label: labels.copySystemInfo,
              click: () => sendMenuCommand('copy-system-info'),
            },
          ],
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/**
 * Apply the native menu for the current platform, using the English
 * fallback labels. macOS gets the full menu bar built above; every other
 * platform clears it (the in-app `AppMenu` dropdown is the entry point
 * there). Must be called before {@link registerMenuIpc} — it also
 * captures the {@link getMainWindow} resolver used by menu click handlers.
 */
export function applyApplicationMenu(
  resolveMainWindow: () => BrowserWindow | null,
): void {
  getMainWindow = resolveMainWindow;
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(buildMacMenu(DEFAULT_MENU_CONFIG));
  } else {
    Menu.setApplicationMenu(null);
  }
}

/**
 * Register the renderer → main channel that pushes localized menu labels
 * and capability flags. Fire-and-forget (`ipcMain.on`) — the renderer
 * does not await a rebuild. No-op off macOS.
 */
export function registerMenuIpc(
  resolveMainWindow: () => BrowserWindow | null,
): void {
  getMainWindow = resolveMainWindow;
  ipcMain.on('menu:configure', (_event, raw: unknown) => {
    if (process.platform !== 'darwin') return;
    Menu.setApplicationMenu(buildMacMenu(normalizeMenuConfig(raw)));
  });
}
