// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { NativeMenuBridge } from './NativeMenuBridge';
import { setDesktopInputFrozen } from '../../utils/desktopInput';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  importCanvas: vi.fn(),
  navigate: vi.fn(),
  settings: vi.fn(),
  onCommand: vi.fn<(listener: (command: string) => void) => () => void>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../hooks/useElectron', () => ({
  getElectronBridge: () => ({
    platform: 'darwin',
    menu: { configure: vi.fn(), onCommand: mocks.onCommand },
  }),
  copySystemInfo: vi.fn(),
  openDeveloperTools: vi.fn(),
  openServerLog: vi.fn(),
}));
vi.mock('../../hooks/useCanvasActions', () => ({
  useCanvasActions: () => ({
    create: mocks.create,
    openImportDialog: mocks.importCanvas,
    fileInputRef: { current: null },
    onFileChange: vi.fn(),
  }),
}));
vi.mock('../../hooks/useRunDiagnostic', () => ({
  useRunDiagnostic: () => vi.fn(),
}));
vi.mock('../../hooks/useAppUpdate', () => ({
  canCheckForUpdates: () => true,
  useAppUpdate: () => ({ status: { state: 'idle' }, check: vi.fn() }),
}));
vi.mock('../../store/settingsUiStore', () => ({
  useSettingsUiStore: (select: (state: { open: () => void }) => unknown) =>
    select({ open: mocks.settings }),
}));
vi.mock('../../store/shortcutsUiStore', () => ({
  useShortcutsUiStore: () => vi.fn(),
}));
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: (
    select: (state: {
      capabilities: { canChangeWorkspace: boolean };
    }) => unknown,
  ) => select({ capabilities: { canChangeWorkspace: true } }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.onCommand.mockReturnValue(vi.fn());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<NativeMenuBridge />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  setDesktopInputFrozen(false);
  container.remove();
});

it('ignores native mutation/navigation commands while saving, then resumes normal dispatch', () => {
  const dispatch = mocks.onCommand.mock.calls.at(-1)?.[0];
  if (!dispatch) throw new Error('Native menu listener was not registered');
  setDesktopInputFrozen(true);
  for (const command of [
    'new-canvas',
    'import-canvas',
    'switch-workspace',
    'open-settings',
  ])
    dispatch(command);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.importCanvas).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.settings).not.toHaveBeenCalled();
  setDesktopInputFrozen(false);
  for (const command of [
    'new-canvas',
    'import-canvas',
    'switch-workspace',
    'open-settings',
  ])
    dispatch(command);
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.importCanvas).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledWith('/setup');
  expect(mocks.settings).toHaveBeenCalledOnce();
});
