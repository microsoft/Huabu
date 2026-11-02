// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { toast } from '@/components/Common/Toast';
import { discardPendingSaves, drainPendingSaves } from '@/store/canvasStore';

import { SpaceNavigationGuard } from './SpaceNavigationGuard';

import type * as Electron from '@/hooks/useElectron';
import type {
  DesktopTabContext,
  DesktopTabsApi,
} from '@huabu/shared/desktop-tabs';

const desktop = vi.hoisted(() => {
  const context: DesktopTabContext = {
    role: 'space',
    canvasId: 'A',
    workspaceId: 'workspace',
  };
  return {
    enabled: false,
    tabs: { context, open: vi.fn<DesktopTabsApi['open']>() },
  };
});
vi.mock('@/hooks/useElectron', async (importActual) => ({
  ...(await importActual<typeof Electron>()),
  getElectronBridge: () =>
    desktop.enabled ? { tabs: desktop.tabs } : undefined,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/store/canvasStore', () => ({
  default: { getState: () => ({ canvasId: 'A' }) },
  drainPendingSaves: vi.fn(),
  discardPendingSaves: vi.fn(),
}));
vi.mock('lottie-react', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(async () => {
  vi.resetAllMocks();
  desktop.enabled = false;
  desktop.tabs.context.role = 'space';
  desktop.tabs.context.canvasId = 'A';
  desktop.tabs.open.mockResolvedValue({ ok: true });
  vi.mocked(drainPendingSaves).mockRejectedValue(new Error('disk unavailable'));
  vi.mocked(discardPendingSaves).mockResolvedValue(undefined);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(
    function (this: HTMLDialogElement) {
      this.open = true;
    },
  );
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = false;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  router = createMemoryRouter(
    [
      {
        element: (
          <>
            <SpaceNavigationGuard />
            <Outlet />
          </>
        ),
        children: [{ path: '*', element: <p>Space content</p> }],
      },
    ],
    { initialEntries: ['/canvas/A'] },
  );
  await act(async () =>
    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  router.dispose();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function navigate(path = '/canvas/B') {
  await act(async () => router.navigate(path));
}

async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}

it.each(['success', 'failure'] as const)(
  'shows a native saving overlay without allowing dismissal, then handles %s',
  async (outcome) => {
    vi.useFakeTimers();
    let resolveSave!: () => void;
    let rejectSave!: (error: Error) => void;
    vi.mocked(drainPendingSaves).mockReturnValue(
      new Promise<void>((resolve, reject) => {
        resolveSave = resolve;
        rejectSave = reject;
      }),
    );
    await navigate();
    await act(async () => vi.advanceTimersByTimeAsync(149));
    expect(host.querySelector('dialog')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2));
    const dialog = host.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-label')).toBe('app.savingCanvas');
    expect(dialog?.classList.contains('fixed')).toBe(true);
    expect(dialog?.querySelector('[data-loading-spinner]')).not.toBeNull();
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    const cancel = new Event('cancel', { cancelable: true });
    act(() => dialog?.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(router.state.location.pathname).toBe('/canvas/A');
    await act(async () => {
      if (outcome === 'success') resolveSave();
      else rejectSave(new Error('disk unavailable'));
    });
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
    expect(host.querySelector('dialog')).toBeNull();
    expect(router.state.location.pathname).toBe(
      outcome === 'success' ? '/canvas/B' : '/canvas/A',
    );
    expect(document.querySelector('[role="dialog"]') !== null).toBe(
      outcome === 'failure',
    );
  },
);

it('keeps the original route until the user decides, and defaults focus to staying', async () => {
  await navigate();
  expect(router.state.location.pathname).toBe('/canvas/A');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.activeElement?.textContent).toBe('app.stayInSpace');
  await click('app.stayInSpace');
  expect(router.state.location.pathname).toBe('/canvas/A');
  expect(discardPendingSaves).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  vi.mocked(drainPendingSaves).mockResolvedValue(undefined);
  await navigate();
  expect(router.state.location.pathname).toBe('/canvas/B');
});

it.each(['/canvas/B', '/spaces'])(
  'discards only after confirmation before leaving for %s',
  async (path) => {
    await navigate(path);
    expect(discardPendingSaves).not.toHaveBeenCalled();
    await click('app.discardAndLeave');
    expect(discardPendingSaves).toHaveBeenCalledExactlyOnceWith('A');
    expect(router.state.location.pathname).toBe(path);
  },
);

it('Escape stays without discarding', async () => {
  await navigate();
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
  );
  expect(router.state.location.pathname).toBe('/canvas/A');
  expect(discardPendingSaves).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps navigation blocked while discarding and surfaces discard errors', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(discardPendingSaves).mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await navigate();
  await click('app.discardAndLeave');
  expect(router.state.location.pathname).toBe('/canvas/A');
  expect(
    [...document.querySelectorAll('button')].every((button) => button.disabled),
  ).toBe(true);
  await act(async () => reject(new Error('discard failed')));
  expect(router.state.location.pathname).toBe('/canvas/A');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    'app.discardFailed',
  );
  await click('app.stayInSpace');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('does not block hash or search changes within the same Space', async () => {
  await navigate('/canvas/A?node=n1#note');
  expect(drainPendingSaves).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

async function enableDesktop() {
  desktop.enabled = true;
  // A local location update renders the retained guard with its desktop context.
  await navigate('/canvas/A?desktop');
}

it('opens cross-Space desktop navigation without draining or replacing the retained Space', async () => {
  await enableDesktop();
  const targetState = { focusNodeId: 'n1' };
  await act(async () =>
    router.navigate('/canvas/B?node=n1#note', { state: targetState }),
  );
  expect(desktop.tabs.open).toHaveBeenCalledExactlyOnceWith({
    canvasId: 'B',
    search: '?node=n1',
    hash: '#note',
    state: targetState,
  });
  expect(router.state.location.pathname).toBe('/canvas/A');
  expect(drainPendingSaves).not.toHaveBeenCalled();
  expect(discardPendingSaves).not.toHaveBeenCalled();
});

it.each(['/spaces', '/setup'])(
  'activates desktop Home for %s without discarding',
  async (path) => {
    await enableDesktop();
    await navigate(path);
    expect(desktop.tabs.open).toHaveBeenCalledExactlyOnceWith({
      canvasId: null,
      homePath: path,
    });
    expect(router.state.location.pathname).toBe('/canvas/A');
    expect(drainPendingSaves).not.toHaveBeenCalled();
  },
);

it('surfaces rejected desktop navigation and permits another attempt', async () => {
  await enableDesktop();
  desktop.tabs.open.mockResolvedValueOnce({
    ok: false,
    error: 'Could not open Tab',
  });
  await navigate();
  expect(toast).toHaveBeenCalledWith('Could not open Tab', { tone: 'danger' });
  expect(router.state.location.pathname).toBe('/canvas/A');
  await navigate();
  expect(desktop.tabs.open).toHaveBeenCalledTimes(2);
  expect(drainPendingSaves).not.toHaveBeenCalled();
});
