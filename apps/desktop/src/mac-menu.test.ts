// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { BrowserWindow, Menu } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { applyApplicationMenu } from './mac-menu.js';

vi.mock('electron', () => ({
  app: { getName: () => 'Huabu' },
  ipcMain: { on: vi.fn() },
  BrowserWindow: class {
    close = vi.fn();
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({})),
    setApplicationMenu: vi.fn(),
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
});

function closeMenuItem() {
  const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0];
  const file = template?.find((item) => item.label === 'File');
  const submenu = file?.submenu;
  if (!Array.isArray(submenu)) throw new Error('Missing File menu');
  const item = submenu.find((entry) => entry.accelerator === 'CmdOrCtrl+W');
  if (!item?.click) throw new Error('Missing Close action');
  return item.click;
}

it('closes the active Space only when the main window is focused', () => {
  const main = new BrowserWindow();
  const closeTab = vi.fn();
  applyApplicationMenu(() => main, undefined, closeTab);
  closeMenuItem()({} as Electron.MenuItem, main, {} as Electron.KeyboardEvent);
  expect(closeTab).toHaveBeenCalledOnce();
  expect(main.close).not.toHaveBeenCalled();
});

it('closes a focused auxiliary window without touching the active Space', () => {
  const main = new BrowserWindow();
  const auxiliary = new BrowserWindow();
  const closeTab = vi.fn();
  applyApplicationMenu(() => main, undefined, closeTab);
  closeMenuItem()(
    {} as Electron.MenuItem,
    auxiliary,
    {} as Electron.KeyboardEvent,
  );
  expect(auxiliary.close).toHaveBeenCalledOnce();
  expect(closeTab).not.toHaveBeenCalled();
  expect(main.close).not.toHaveBeenCalled();
});

it('does nothing when there is no focused window', () => {
  const main = new BrowserWindow();
  const closeTab = vi.fn();
  applyApplicationMenu(() => main, undefined, closeTab);
  closeMenuItem()(
    {} as Electron.MenuItem,
    undefined,
    {} as Electron.KeyboardEvent,
  );
  expect(closeTab).not.toHaveBeenCalled();
  expect(main.close).not.toHaveBeenCalled();
});

it('closes the focused main window normally when Tabs are not configured', () => {
  const main = new BrowserWindow();
  applyApplicationMenu(() => main);
  closeMenuItem()({} as Electron.MenuItem, main, {} as Electron.KeyboardEvent);
  expect(main.close).toHaveBeenCalledOnce();
});

it('focuses active content before dispatching native Settings', () => {
  const main = new BrowserWindow();
  const contents = {
    isDestroyed: () => false,
    focus: vi.fn(),
    send: vi.fn(),
  };
  applyApplicationMenu(
    () => main,
    () => contents as never,
  );
  const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0];
  const submenu = template?.[0].submenu;
  if (!Array.isArray(submenu)) throw new Error('Missing application menu');
  const settings = submenu.find((item) => item.accelerator === 'CmdOrCtrl+,');
  if (!settings?.click) throw new Error('Missing Settings action');
  settings.click({} as Electron.MenuItem, main, {} as Electron.KeyboardEvent);
  expect(contents.focus).toHaveBeenCalledOnce();
  expect(contents.send).toHaveBeenCalledWith('menu:command', 'open-settings');
  expect(contents.focus.mock.invocationCallOrder[0]).toBeLessThan(
    contents.send.mock.invocationCallOrder[0],
  );
});
