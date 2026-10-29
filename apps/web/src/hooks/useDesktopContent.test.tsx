// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  queryConversationTitles,
  setConversationTitle,
} from '@/api/conversationTitles';
import useCanvasStore from '@/store/canvasStore';
import {
  renameConversationTitle,
  refreshConversationTitles,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';
import { useDesktopTabStore } from '@/store/desktopTabStore';
import {
  installDesktopInputGuard,
  isDesktopInputFrozen,
} from '@/utils/desktopInput';
import { pageLifecycle } from '@/utils/pageLifecycle';

import { useDesktopContent } from './useDesktopContent';
import { getElectronBridge } from './useElectron';

import type { toast } from '@/components/Common/Toast';
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
  preprocess: vi.fn(),
  flush: vi.fn(),
  prepare: vi.fn<(listener: (requestId: string) => void) => () => void>(),
  resume: vi.fn<(listener: () => void) => () => void>(),
  finish: vi.fn(),
  heartbeat: vi.fn(),
  prepared: vi.fn<(listener: () => void) => () => void>(),
  navigate: vi.fn(),
  toast: vi.fn<typeof toast>(),
  setWorldEnabled: vi.fn(),
  setWorkspaceState: vi.fn(),
  setCanvasState: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/api/conversationTitles', () => ({
  setConversationTitle: vi.fn(),
  queryConversationTitles: vi.fn(),
}));
vi.mock('./useElectron', () => {
  const bridge = {
    platform: 'darwin',
    tabs: {
      context: mocks.context,
      onNavigate: () => () => {},
      onPrepareClose: mocks.prepare,
      onResume: mocks.resume,
      finishPrepareClose: mocks.finish,
      keepPrepareCloseAlive: mocks.heartbeat,
      onClosePrepared: mocks.prepared,
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
  drainNodePreprocessing: mocks.preprocess,
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
  useChatPreferencesStore: { persist: { rehydrate: vi.fn() } },
}));
vi.mock('@/store/toolStore', () => ({
  useToolStore: { persist: { rehydrate: vi.fn() } },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const { saving, preparingClose, cancelClose } = useDesktopContent();
  return (
    <div data-saving={saving} data-frozen={preparingClose}>
      <button onClick={cancelClose}>Cancel close</button>
    </div>
  );
}

describe('desktop save presentation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let removeInputGuard: () => void;
  let removeCanvasPreparation: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    useConversationTitleStore.setState({ entries: {}, pending: {} });
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
    mocks.preprocess.mockResolvedValue(undefined);
    mocks.prepare.mockReturnValue(vi.fn());
    mocks.resume.mockReturnValue(vi.fn());
    mocks.prepared.mockReturnValue(vi.fn());
    removeCanvasPreparation = pageLifecycle.register('test-canvas', {
      flush: async () => {
        const canvasId = mocks.canvas.canvasId;
        if (canvasId) {
          await mocks.save(canvasId);
          await mocks.preprocess();
          await mocks.save(canvasId);
        }
        mocks.flush();
      },
    });
    removeInputGuard = installDesktopInputGuard();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    removeInputGuard();
    removeCanvasPreparation();
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

  it('deduplicates irrelevant Store updates while reporting a real title change', async () => {
    let changed: (() => void) | undefined;
    const subscription = vi
      .spyOn(useCanvasStore, 'subscribe')
      .mockImplementation((listener) => {
        changed = () =>
          listener(useCanvasStore.getState(), useCanvasStore.getState());
        return () => {};
      });
    const title = mocks.canvas.canvasTitle;
    try {
      await render();
      const report = getElectronBridge()?.tabs?.report;
      expect(report).toHaveBeenCalledOnce();
      for (let i = 0; i < 5; i++) {
        changed?.();
        await act(async () => vi.advanceTimersByTime(100));
      }
      expect(report).toHaveBeenCalledOnce();
      mocks.canvas.canvasTitle = 'Renamed';
      changed?.();
      await act(async () => vi.advanceTimersByTime(100));
      expect(report).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: 'Renamed' }),
      );
    } finally {
      mocks.canvas.canvasTitle = title;
      subscription.mockRestore();
    }
  });

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
    mocks.setWorkspaceState.mockClear();
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
      mocks.setWorkspaceState.mockClear();
      mocks.setCanvasState.mockClear();
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
    mocks.setWorkspaceState.mockClear();
    mocks.setCanvasState.mockClear();
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
    await act(async () => mocks.prepared.mock.calls[0][0]());
    await act(async () => vi.advanceTimersByTime(1000));
    expectPresentation(false, true);
    expect(isDesktopInputFrozen()).toBe(true);
    expect(document.body.inert).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.preprocess).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith('save-request', { ok: true });
    await resume();
    expectPresentation(false, false);
    expect(isDesktopInputFrozen()).toBe(false);
    expect(document.body.inert).toBe(false);
  });

  it('waits for preprocessing queued by editor blur before acknowledging close', async () => {
    let complete!: () => void;
    const editor = document.createElement('textarea');
    document.body.appendChild(editor);
    editor.focus();
    editor.addEventListener('blur', () => {
      mocks.preprocess.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
    });
    try {
      await render();
      await prepare();
      expect(mocks.save).toHaveBeenCalledWith('space-a');
      expect(mocks.preprocess).toHaveBeenCalledOnce();
      expect(mocks.finish).not.toHaveBeenCalled();
      await act(async () => complete());
      expect(mocks.save).toHaveBeenCalledTimes(2);
      expect(mocks.finish).toHaveBeenCalledWith('save-request', { ok: true });
    } finally {
      editor.remove();
    }
  });

  it('rejects close and reports a preprocessing drain failure', async () => {
    mocks.preprocess.mockRejectedValueOnce(
      new Error('Restored content is pending'),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await render();
      await prepare();
      expect(mocks.finish).toHaveBeenCalledWith('save-request', {
        ok: false,
        error: 'Restored content is pending',
      });
      expect(mocks.toast).toHaveBeenCalledWith('Restored content is pending', {
        tone: 'danger',
      });
      expect(mocks.save).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('keeps cancellation available after its own save until all pages are prepared', async () => {
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
    expectPresentation(true, true);
    expect(mocks.flush).toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith('save-request', { ok: true });
    await resume();
    expectPresentation(false, false);
  });

  it('does not flash the message for a fast save', async () => {
    await render();
    await prepare();
    await act(async () => mocks.prepared.mock.calls[0][0]());
    await act(async () => vi.advanceTimersByTime(150));
    expectPresentation(false, true);
    expect(mocks.save).toHaveBeenCalledWith('space-a');
    expect(mocks.finish).toHaveBeenCalledWith('save-request', { ok: true });
  });

  it('waits for Home imports, keeps the handshake alive, and cancels without cancelling the import', async () => {
    mocks.context.role = 'home';
    mocks.canvas.canvasId = null;
    let complete!: () => void;
    const importing = pageLifecycle.run(
      'importing',
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await render();
    await prepare();
    await act(async () => vi.advanceTimersByTime(20_000));
    expectPresentation(true, true);
    expect(mocks.heartbeat).toHaveBeenCalledTimes(4);
    expect(mocks.finish).not.toHaveBeenCalled();
    // React's event handler remains testable while the real page is inert.
    const button = container.querySelector('button');
    if (!button?.parentElement) throw new Error('Missing cancel control');
    const controls = document.createElement('dialog');
    controls.setAttribute('data-desktop-close-controls', '');
    controls.setAttribute('open', '');
    button.parentElement.appendChild(controls);
    controls.appendChild(button);
    await act(async () => button.click());
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith('save-request', {
      ok: false,
      error: 'Closing was cancelled.',
      cancelled: true,
    });
    await resume();
    await act(async () => {
      complete();
      await importing;
    });
    expect(mocks.finish).toHaveBeenCalledOnce();
    expectPresentation(false, false);
  });

  it('never acknowledges an obsolete request after resume', async () => {
    let complete!: () => void;
    mocks.save.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    await prepare();
    await resume();
    await act(async () => complete());
    expect(mocks.finish).not.toHaveBeenCalled();
    expectPresentation(false, false);
  });

  it.each(['replace', 'resume'] as const)(
    'can retry a pending preparation immediately after %s',
    async (mode) => {
      let complete!: () => void;
      mocks.save.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
      );
      await render();
      await prepare();
      await act(async () => {
        if (mode === 'resume') mocks.resume.mock.calls[0][0]();
        mocks.prepare.mock.calls[0][0]('retry-request');
      });
      expect(mocks.finish).toHaveBeenCalledExactlyOnceWith('retry-request', {
        ok: true,
      });
      expect(mocks.toast).not.toHaveBeenCalled();
      await act(async () => complete());
      expect(mocks.finish).toHaveBeenCalledOnce();
      await resume();
      expectPresentation(false, false);
      expect(isDesktopInputFrozen()).toBe(false);
    },
  );

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

  it.each([
    ['already-running', true],
    ['already-running', false],
    ['started-by-blur', true],
    ['started-by-blur', false],
  ] as const)(
    'waits for a %s title rename and acknowledges its result (success=%s)',
    async (timing, success) => {
      let resolve!: (value: { title: string; source: 'user' }) => void;
      let reject!: (error: Error) => void;
      let result: Promise<unknown> | undefined;
      vi.mocked(setConversationTitle).mockReturnValueOnce(
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      const start = () => {
        result = renameConversationTitle(
          'space-a',
          'title-thread',
          'Renamed title',
          false,
        ).catch((error: unknown) => error);
      };
      const input = document.createElement('input');
      document.body.appendChild(input);
      if (timing === 'started-by-blur') {
        input.addEventListener('blur', start);
        input.focus();
      } else start();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await render();
        await prepare();
        expect(result).toBeDefined();
        expect(setConversationTitle).toHaveBeenCalledWith(
          'space-a',
          'title-thread',
          { title: 'Renamed title' },
        );
        expect(mocks.finish).not.toHaveBeenCalled();
        expect(mocks.flush).not.toHaveBeenCalled();
        expect(isDesktopInputFrozen()).toBe(true);
        await act(async () => {
          if (success) resolve({ title: 'Renamed title', source: 'user' });
          else reject(new Error('Title write offline'));
          await result;
        });
        expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(
          'save-request',
          success ? { ok: true } : { ok: false, error: 'Title write offline' },
        );
        if (success) expect(mocks.flush).toHaveBeenCalledOnce();
        else {
          expect(mocks.flush).not.toHaveBeenCalled();
          expect(mocks.toast).toHaveBeenCalledWith('Title write offline', {
            tone: 'danger',
            action: {
              label: 'Retry title save',
              onClick: expect.any(Function),
            },
          });
        }
      } finally {
        input.remove();
        reject?.(new Error('Test cleanup'));
        await result;
        log.mockRestore();
      }
    },
  );

  it('rejects close after a local draft write fails and exposes retry that persists it before the next close', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Draft storage full');
    });
    try {
      await expect(
        renameConversationTitle('space-a', 'draft', 'Keep draft', true),
      ).rejects.toThrow('Draft storage full');
      await render();
      await prepare();
      expect(mocks.finish).toHaveBeenLastCalledWith('save-request', {
        ok: false,
        error: 'Draft storage full',
      });
      expect(mocks.flush).not.toHaveBeenCalled();
      await resume();
      const retry = mocks.toast.mock.lastCall?.[1]?.action;
      if (!retry) throw new Error('Missing local persistence retry');
      storage.mockRestore();
      await act(async () => retry.onClick());
      const persisted = JSON.parse(
        localStorage.getItem('huabu.conversationTitleDrafts') ?? '{}',
      );
      expect(
        persisted.state.pending[JSON.stringify(['space-a', 'draft'])],
      ).toBe('Keep draft');
      await prepare();
      expect(mocks.finish).toHaveBeenLastCalledWith('save-request', {
        ok: true,
      });
    } finally {
      storage.mockRestore();
      log.mockRestore();
    }
  });

  it('acknowledges close after a read-only title query fails for a safely persisted draft', async () => {
    await renameConversationTitle('space-a', 'draft', 'Safe draft', true);
    vi.mocked(queryConversationTitles).mockRejectedValueOnce(
      new Error('Query offline'),
    );
    await refreshConversationTitles('space-a', ['draft']);
    await render();
    await prepare();
    expect(mocks.finish).toHaveBeenLastCalledWith('save-request', { ok: true });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('offers repeatable title recovery from save feedback without acknowledging or discarding the page', async () => {
    vi.mocked(setConversationTitle).mockRejectedValueOnce(new Error('Offline'));
    await renameConversationTitle(
      'space-a',
      'closed-chat',
      'Retained title',
      false,
    ).catch(() => {});
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await render();
      await prepare();
      expect(mocks.finish).toHaveBeenLastCalledWith('save-request', {
        ok: false,
        error: 'Offline',
      });

      await resume();
      const firstRetry = mocks.toast.mock.lastCall?.[1]?.action;
      if (!firstRetry) throw new Error('Missing save-error retry action');
      vi.mocked(setConversationTitle).mockRejectedValueOnce(
        new Error('Still offline'),
      );
      await act(async () => firstRetry.onClick());
      expect(mocks.toast).toHaveBeenLastCalledWith('Still offline', {
        tone: 'danger',
        action: { label: 'Retry title save', onClick: expect.any(Function) },
      });
      const retry = mocks.toast.mock.lastCall?.[1]?.action;
      if (!retry) throw new Error('Missing repeated retry action');
      vi.mocked(setConversationTitle).mockResolvedValueOnce({
        title: 'Retained title',
        source: 'user',
      });
      await act(async () => retry.onClick());
      expect(mocks.finish).toHaveBeenCalledTimes(1);
      expect(isDesktopInputFrozen()).toBe(false);
      await prepare();
      expect(mocks.finish).toHaveBeenLastCalledWith('save-request', {
        ok: true,
      });
    } finally {
      log.mockRestore();
    }
  });
});
