// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppMenu } from './AppMenu';

import type * as DropdownMenuExports from '../../Common/DropdownMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../config/handbook', () => ({ openUserHandbook: vi.fn() }));
vi.mock('../../../config/shortcuts', () => ({
  getShortcutKeys: () => undefined,
}));
vi.mock('../../../hooks/useAppUpdate', () => ({
  canCheckForUpdates: () => true,
  useAppUpdate: () => ({ status: { state: 'idle' }, check: vi.fn() }),
}));
vi.mock('../../../hooks/useCanvasActions', () => ({
  useCanvasActions: () => ({
    create: vi.fn(),
    openImportDialog: vi.fn(),
    fileInputRef: { current: null },
    onFileChange: vi.fn(),
  }),
}));
vi.mock('../../../hooks/useElectron', () => ({
  copySystemInfo: vi.fn(),
  desktopDiagnosticsAvailable: () => false,
  getElectronBridge: () => null,
  isElectron: () => false,
  openDeveloperTools: vi.fn(),
  openServerLog: vi.fn(),
}));
vi.mock('../../../hooks/useRunDiagnostic', () => ({
  useRunDiagnostic: () => vi.fn(),
}));
vi.mock('../../../store/settingsUiStore', () => ({
  useSettingsUiStore: (select: (state: { open: () => void }) => unknown) =>
    select({ open: vi.fn() }),
}));
vi.mock('../../../store/shortcutsUiStore', () => ({
  useShortcutsUiStore: (select: (state: { open: () => void }) => unknown) =>
    select({ open: vi.fn() }),
}));
vi.mock('../../../store/workspaceStore', () => ({
  useWorkspaceStore: (
    select: (state: {
      capabilities: { canChangeWorkspace: boolean };
      worldCanvasId: null;
      worldEnabled: boolean;
    }) => unknown,
  ) =>
    select({
      capabilities: { canChangeWorkspace: true },
      worldCanvasId: null,
      worldEnabled: false,
    }),
}));
vi.mock('../../Common/DropdownMenu', async (importOriginal) => {
  const actual = await importOriginal<typeof DropdownMenuExports>();
  return {
    ...actual,
    DropdownMenu: ({
      trigger,
      children,
    }: {
      trigger: ReactNode;
      children: ReactNode;
    }) => (
      <>
        {trigger}
        {children}
      </>
    ),
    DropdownMenuSubmenu: () => null,
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('AppMenu', () => {
  it('gives the hidden Space-import field a stable form name', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <MemoryRouter initialEntries={['/canvas/c1']}>
          <AppMenu />
        </MemoryRouter>,
      ),
    );

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput?.name).toBe('space-import-archive');
  });

  it('renders Back to Space list as a native router link', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <MemoryRouter initialEntries={['/canvas/c1']}>
          <AppMenu />
        </MemoryRouter>,
      ),
    );

    const link = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]'),
    ).find((candidate) =>
      candidate.textContent?.includes('canvasPage.backToList'),
    );
    expect(link?.getAttribute('href')).toBe('/spaces');
  });
});
