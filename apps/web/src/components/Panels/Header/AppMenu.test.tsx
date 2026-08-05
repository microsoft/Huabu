import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppMenu } from './AppMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/canvas/c1' }),
  useNavigate: () => vi.fn(),
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
vi.mock('../../Common/DropdownMenu', () => ({
  DropdownMenu: ({ trigger }: { trigger: ReactNode }) => trigger,
  DropdownMenuItem: () => null,
  DropdownMenuSubmenu: () => null,
}));

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

    act(() => root?.render(<AppMenu />));

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput?.name).toBe('space-import-archive');
  });
});
