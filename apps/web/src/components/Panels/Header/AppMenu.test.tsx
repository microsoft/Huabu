// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppMenu } from './AppMenu';
import { useIdentityStore } from '../../../store/identityStore';
import {
  isDesktopInputFrozen,
  setDesktopInputFrozen,
} from '../../../utils/desktopInput';

import type * as DropdownMenuExports from '../../Common/DropdownMenu';
import type { IdentityResponse } from '@huabu/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../config/handbook', () => ({ openUserHandbook: vi.fn() }));
const signOutMocks = vi.hoisted(() => ({
  saved: vi.fn<() => Promise<boolean>>(),
  signOut: vi.fn<() => Promise<void>>(),
  toast: vi.fn(),
}));
vi.mock('../../../store/canvasStore', () => ({
  savedBeforeSignOut: signOutMocks.saved,
}));
vi.mock('../../../api/identity', () => ({ signOut: signOutMocks.signOut }));
vi.mock('../../Common/Toast.tsx', () => ({ toast: signOutMocks.toast }));
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
  it.each([
    { triggerClassName: undefined, padding: 'p-0.5' },
    { triggerClassName: 'p-0', padding: 'p-0' },
  ])(
    'allows compact trigger alignment with $padding',
    ({ triggerClassName, padding }) => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root?.render(
          <MemoryRouter initialEntries={['/canvas/c1']}>
            <AppMenu compact triggerClassName={triggerClassName} />
          </MemoryRouter>,
        ),
      );
      const trigger = container.querySelector(
        'button[aria-label="navigation.appMenu"]',
      );
      expect(trigger?.classList.contains(padding)).toBe(true);
      expect(trigger?.querySelector('img')?.className).toBe('h-6 w-6');
    },
  );

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

  it('offers sign-out only to a Bubble-signed-in caller', () => {
    const items = (identity: IdentityResponse | null) => {
      useIdentityStore.setState({ identity });
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root?.render(
          <MemoryRouter initialEntries={['/spaces']}>
            <AppMenu />
          </MemoryRouter>,
        ),
      );
      const labels = Array.from(
        container.querySelectorAll('[role="menuitem"]'),
      ).map((item) => item.textContent);
      act(() => root?.unmount());
      container.remove();
      return labels;
    };
    const principal = { principalId: 'carol', kind: 'user' as const };
    expect(items(null)).not.toContain('auth.signOutAs');
    expect(
      items({ provider: 'local', principal, member: true, owner: true }),
    ).not.toContain('auth.signOutAs');
    expect(
      items({ provider: 'bubble', principal, member: true, owner: false }),
    ).toContain('auth.signOutAs');
  });

  it('signs out only once Canvas edits are saved, and says so otherwise', async () => {
    useIdentityStore.setState({
      identity: {
        provider: 'bubble',
        principal: { principalId: 'carol', kind: 'user' },
        member: true,
        owner: false,
      },
    });
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
    const signOutItem = () =>
      Array.from(
        container!.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((item) => item.textContent?.includes('auth.signOutAs'));
    let settleSave!: (saved: boolean) => void;
    signOutMocks.saved.mockReturnValueOnce(
      new Promise((resolve) => (settleSave = resolve)),
    );
    await act(async () => signOutItem()?.click());
    // No edit can start while the last saves run.
    expect(isDesktopInputFrozen()).toBe(true);
    expect(document.body.inert).toBe(true);
    await act(async () => settleSave(false));
    expect(isDesktopInputFrozen()).toBe(false);
    expect(document.body.inert).toBe(false);
    expect(signOutMocks.signOut).not.toHaveBeenCalled();
    expect(signOutMocks.toast).toHaveBeenCalledWith('auth.signOutUnsaved', {
      tone: 'danger',
    });

    signOutMocks.saved.mockResolvedValueOnce(true);
    signOutMocks.signOut.mockRejectedValueOnce(new Error('503'));
    await act(async () => signOutItem()?.click());
    expect(signOutMocks.signOut).toHaveBeenCalledTimes(1);
    expect(signOutMocks.toast).toHaveBeenLastCalledWith('auth.signOutFailed', {
      tone: 'danger',
    });
    expect(isDesktopInputFrozen()).toBe(false);

    // A successful sign-out navigates away, so input stays frozen.
    signOutMocks.saved.mockResolvedValueOnce(true);
    signOutMocks.signOut.mockResolvedValueOnce();
    await act(async () => signOutItem()?.click());
    expect(isDesktopInputFrozen()).toBe(true);
    setDesktopInputFrozen(false);
  });
});
