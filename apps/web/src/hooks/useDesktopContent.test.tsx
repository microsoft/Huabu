// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDesktopTabStore } from '@/store/desktopTabStore';
import {
  installDesktopInputGuard,
  isDesktopInputFrozen,
} from '@/utils/desktopInput';

import { useDesktopContent } from './useDesktopContent';

import type { DesktopTabsSnapshot } from '@huabu/shared/desktop-tabs';

const mocks = vi.hoisted(() => ({
  context: { role: 'space', canvasId: 'space-a', workspaceId: 'workspace' },
  state: vi.fn<() => Promise<DesktopTabsSnapshot>>(),
  onState:
    vi.fn<(listener: (state: DesktopTabsSnapshot) => void) => () => void>(),
  canvas: {
    canvasId: 'space-a' as string | null,
    canvasTitle: 'Space A',
    isLoading: false,
    nodes: [],
  },
  save: vi.fn(),
  flush: vi.fn(),
  prepare: vi.fn<(listener: (requestId: string) => void) => () => void>(),
  resume: vi.fn<(listener: () => void) => () => void>(),
  finish: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  setWorldEnabled: vi.fn(),
  setWorkspaceState: vi.fn(),
  setCanvasState: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('./useElectron', () => {
  const bridge = {
    platform: 'darwin',
    tabs: {
      context: mocks.context,
      onNavigate: () => () => {},
      onPrepareClose: mocks.prepare,
      onResume: mocks.resume,
      finishPrepareClose: mocks.finish,
      ready: vi.fn(),
      report: vi.fn(),
      getState: mocks.state,
      onState: mocks.onState,
    },
  };
  return {
    getElectronBridge: () => bridge,
    requireDesktopTabSuccess: vi.fn(),
  };
});
vi.mock('@/components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => mocks.canvas,
    setState: mocks.setCanvasState,
    subscribe: () => () => {},
  },
  saveCanvasForSubmission: mocks.save,
  flushCanvasViewState: mocks.flush,
}));
vi.mock('@/store/chatStore', () => ({
  useChatStore: {
    getState: () => ({ threadsById: {} }),
    subscribe: () => () => {},
  },
}));
vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: { isReady: boolean; isSyncing: boolean }) => unknown) =>
      selector({ isReady: false, isSyncing: false }),
    {
      getState: () => ({
        workspaceName: 'Workspace',
        setWorldEnabled: mocks.setWorldEnabled,
      }),
      setState: mocks.setWorkspaceState,
      subscribe: () => () => {},
    },
  ),
}));
vi.mock('@/store/chatPreferencesStore', () => ({
  useChatPreferencesStore: {},
}));
vi.mock('@/store/toolStore', () => ({ useToolStore: {} }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const { saving, preparingClose } = useDesktopContent();
  return <div data-saving={saving} data-frozen={preparingClose} />;
}

describe('desktop save presentation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let removeInputGuard: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    useDesktopTabStore.setState({ isActive: false });
    mocks.state.mockResolvedValue({
      tabs: [],
      activeId: 'home',
      workspaceId: 'workspace',
      busy: false,
    });
    mocks.onState.mockReturnValue(vi.fn());
    mocks.context.role = 'space';
    mocks.canvas.canvasId = 'space-a';
    mocks.canvas.isLoading = false;
    mocks.save.mockResolvedValue(undefined);
    mocks.prepare.mockReturnValue(vi.fn());
    mocks.resume.mockReturnValue(vi.fn());
    removeInputGuard = installDesktopInputGuard();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    removeInputGuard();
    vi.useRealTimers();
  });

  async function render() {
    await act(async () => root.render(<Harness />));
  }

  async function prepare() {
    await act(async () => mocks.prepare.mock.calls[0][0]('save-request'));
  }

  async function resume() {
    await act(async () => mocks.resume.mock.calls[0][0]());
  }

  function expectPresentation(saving: boolean, frozen: boolean) {
    expect(container.firstElementChild?.getAttribute('data-saving')).toBe(
      String(saving),
    );
    expect(container.firstElementChild?.getAttribute('data-frozen')).toBe(
      String(frozen),
    );
  }

  it('does not show a saving message when a Space is loading', async () => {
    mocks.canvas.isLoading = true;
    await render();
    await act(async () => vi.advanceTimersByTime(1000));
    expectPresentation(false, false);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('tracks desktop activation and ignores an older initial snapshot', async () => {
    let resolve!: (state: DesktopTabsSnapshot) => void;
    mocks.state.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    const update = mocks.onState.mock.calls.at(-1)?.[0];
    if (!update) throw new Error('Missing activation listener');
    const active: DesktopTabsSnapshot = {
      tabs: [
        {
          id: 'a',
          canvasId: 'space-a',
          title: 'A',
          loading: false,
          running: false,
          unread: false,
          error: null,
        },
      ],
      activeId: 'a',
      workspaceId: 'workspace',
      busy: false,
    };
    await act(async () => update(active));
    expect(useDesktopTabStore.getState().isActive).toBe(true);
    await act(async () => resolve({ ...active, activeId: 'home' }));
    expect(useDesktopTabStore.getState().isActive).toBe(true);
    await act(async () => update({ ...active, activeId: 'home' }));
    expect(useDesktopTabStore.getState().isActive).toBe(false);
    await act(async () => update({ ...active, workspaceId: 'other' }));
    expect(useDesktopTabStore.getState().isActive).toBe(false);
  });

  it.each([
    [
      new Error('Cannot submit before Canvas space-a is saved', {
        cause: new Error('Network offline'),
      }),
      'Network offline',
    ],
    [
      new Error('Cannot submit before Canvas space-a is saved', {
        cause: 'unknown',
      }),
      'Cannot submit before Canvas space-a is saved',
    ],
  ])(
    'reports the underlying save cause when available',
    async (error, message) => {
      mocks.save.mockRejectedValue(error);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await render();
        await prepare();
        expect(mocks.toast).toHaveBeenCalledWith(message, { tone: 'danger' });
        expect(mocks.finish).toHaveBeenCalledWith('save-request', {
          ok: false,
          error: message,
        });
        expect(isDesktopInputFrozen()).toBe(true);
      } finally {
        log.mockRestore();
      }
    },
  );

  it('hydrates queued World preference notifications without echoing writes to main', async () => {
    await render();
    for (const value of ['true', 'false']) {
      localStorage.setItem('huabu:world-enabled', value);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'huabu:world-enabled',
          newValue: value,
        }),
      );
    }
    expect(mocks.setWorldEnabled).not.toHaveBeenCalled();
    expect(mocks.setWorkspaceState.mock.calls).toEqual([
      [{ worldEnabled: true }],
      [{ worldEnabled: false }],
    ]);
  });

  it.each(['true', 'false'])(
    'uses current World and MiniMap preferences instead of stale native event values (%s)',
    async (current) => {
      mocks.context.role = 'home';
      await render();
      const stale = current === 'true' ? 'false' : 'true';
      for (const key of ['huabu:world-enabled', 'huabu.minimapEnabled']) {
        localStorage.setItem(key, current);
        window.dispatchEvent(
          new StorageEvent('storage', { key, newValue: stale }),
        );
      }
      expect(mocks.setWorkspaceState).toHaveBeenCalledExactlyOnceWith({
        worldEnabled: current === 'true',
      });
      expect(mocks.setCanvasState).toHaveBeenCalledExactlyOnceWith({
        minimapEnabled: current === 'true',
      });
      expect(mocks.setWorldEnabled).not.toHaveBeenCalled();
    },
  );

  it('applies removed preferences as disabled despite a queued enabled event', async () => {
    await render();
    for (const key of ['huabu:world-enabled', 'huabu.minimapEnabled'])
      window.dispatchEvent(
        new StorageEvent('storage', { key, newValue: 'true' }),
      );
    expect(mocks.setWorkspaceState).toHaveBeenCalledExactlyOnceWith({
      worldEnabled: false,
    });
    expect(mocks.setCanvasState).toHaveBeenCalledExactlyOnceWith({
      minimapEnabled: false,
    });
  });

  it('never shows saving on Home, including while waiting for Workspace activation', async () => {
    mocks.context.role = 'home';
    mocks.canvas.canvasId = null;
    await render();
    await prepare();
    await act(async () => vi.advanceTimersByTime(1000));
    expectPresentation(false, true);
    expect(isDesktopInputFrozen()).toBe(true);
    expect(document.body.inert).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith('save-request', { ok: true });
    await resume();
    expectPresentation(false, false);
    expect(isDesktopInputFrozen()).toBe(false);
    expect(document.body.inert).toBe(false);
  });

  it('hides the message after saving but keeps input frozen until resumed', async () => {
    let completeSave: () => void;
    mocks.save.mockReturnValue(
      new Promise<void>((resolve) => {
        completeSave = resolve;
      }),
    );
    await render();
    await prepare();
    expectPresentation(false, true);
    await act(async () => vi.advanceTimersByTime(149));
    expectPresentation(false, true);
    await act(async () => vi.advanceTimersByTime(1));
    expectPresentation(true, true);
    expect(mocks.finish).not.toHaveBeenCalled();
    await act(async () => completeSave());
    expectPresentation(false, true);
    expect(mocks.flush).toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith('save-request', { ok: true });
    await resume();
    expectPresentation(false, false);
  });

  it('does not flash the message for a fast save', async () => {
    await render();
    await prepare();
    await act(async () => vi.advanceTimersByTime(150));
    expectPresentation(false, true);
    expect(mocks.save).toHaveBeenCalledWith('space-a');
    expect(mocks.finish).toHaveBeenCalledWith('save-request', { ok: true });
  });

  it('blocks window shortcuts and portal clicks after acknowledgement until resume', async () => {
    await render();
    const shortcut = vi.fn();
    const portalAction = vi.fn();
    const portalButton = document.createElement('button');
    portalButton.addEventListener('click', portalAction);
    document.body.appendChild(portalButton);
    window.addEventListener('keydown', shortcut, true);
    try {
      await prepare();
      expect(mocks.finish).toHaveBeenCalledWith('save-request', { ok: true });
      const key = new KeyboardEvent('keydown', {
        key: 'Delete',
        cancelable: true,
      });
      window.dispatchEvent(key);
      portalButton.click();
      expect(key.defaultPrevented).toBe(true);
      expect(shortcut).not.toHaveBeenCalled();
      expect(portalAction).not.toHaveBeenCalled();
      await resume();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
      portalButton.click();
      expect(shortcut).toHaveBeenCalledOnce();
      expect(portalAction).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('keydown', shortcut, true);
      portalButton.remove();
    }
  });

  it('reports a save failure and clears the message without prematurely enabling input', async () => {
    const error = new Error('Disk full');
    mocks.save.mockRejectedValue(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await render();
      await prepare();
      await act(async () => vi.advanceTimersByTime(150));
      expectPresentation(false, true);
      expect(log).toHaveBeenCalledWith(
        '[desktop-tabs] Could not save Space:',
        error,
      );
      expect(mocks.toast).toHaveBeenCalledWith('Disk full', { tone: 'danger' });
      expect(mocks.finish).toHaveBeenCalledWith('save-request', {
        ok: false,
        error: 'Disk full',
      });
      await resume();
      expectPresentation(false, false);
    } finally {
      log.mockRestore();
    }
  });
});
