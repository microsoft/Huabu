// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import {
  queryConversationTitles,
  setConversationTitle,
} from '@/api/conversationTitles';
import {
  conversationTitleKey,
  getConversationTitle,
  refreshConversationTitleAfterStream,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';
import {
  activateTab,
  closeTab,
  createEmptyWorkspace,
  openTarget,
} from '@/store/previewWorkspace/model';

import { useConversationTitles } from './useConversationTitles';

import type {
  CanvasPreviewWorkspace,
  PreviewTarget,
} from '@/store/previewWorkspace/model';
import type {
  ConversationTitle,
  QueryConversationTitlesResponse,
} from '@huabu/shared';

vi.mock('@/api/conversationTitles', () => ({
  queryConversationTitles: vi.fn(),
  setConversationTitle: vi.fn(),
}));

const query = vi.mocked(queryConversationTitles);
const retryDelays = [1000, 3000, 10000, 30000, 60000];
const unmounts = new Set<() => void>();
const settleRequests = new Set<() => void>();
const chat = (threadId: string, canvasId = 'canvas'): PreviewTarget => ({
  kind: 'chat',
  canvasId,
  threadId,
});

function workspaceWith(...targets: PreviewTarget[]): CanvasPreviewWorkspace {
  return targets.reduce(
    (workspace, target, index) =>
      openTarget(workspace, target, {}, { tabId: `tab-${index}` }).workspace,
    createEmptyWorkspace('primary'),
  );
}

function response(
  threadIds: string[],
  source: ConversationTitle['source'] = 'fallback',
  prefix = 'Prompt',
): QueryConversationTitlesResponse {
  return {
    titles: Object.fromEntries(
      threadIds.map((id) => [id, { title: `${prefix} ${id}`, source }]),
    ),
  };
}

function deferredResponse() {
  let resolve!: (value: QueryConversationTitlesResponse) => void;
  const promise = new Promise<QueryConversationTitlesResponse>((done) => {
    resolve = done;
  });
  // Release the real store's module-level in-flight map even if an assertion fails.
  const settle = () => resolve({ titles: {} });
  settleRequests.add(settle);
  return {
    promise,
    resolve(value: QueryConversationTitlesResponse) {
      settleRequests.delete(settle);
      resolve(value);
    },
  };
}

/** Match the repository's createRoot/act harness without adding a test dependency. */
async function renderHook(workspace: CanvasPreviewWorkspace) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Harness({ value }: { value: CanvasPreviewWorkspace }) {
    useConversationTitles(value);
    return null;
  }
  const rerender = async (value: CanvasPreviewWorkspace) => {
    await act(async () => {
      root.render(<Harness value={value} />);
    });
  };
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
    unmounts.delete(unmount);
  };
  unmounts.add(unmount);
  await rerender(workspace);
  return { rerender, unmount };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function focus() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  localStorage.clear();
  useConversationTitleStore.setState({
    entries: {},
    pending: {},
    refreshEpoch: 0,
  });
  query.mockImplementation(async ({ threadIds }) => response(threadIds));
});

afterEach(async () => {
  for (const unmount of unmounts) unmount();
  await act(async () => {
    for (const settle of settleRequests) settle();
    settleRequests.clear();
  });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useConversationTitles', () => {
  it('bounds pending saves for absent untitled threads and retries on focus', async () => {
    const key = conversationTitleKey('canvas', 'draft');
    useConversationTitleStore.setState({ pending: { [key]: 'Manual draft' } });
    query.mockResolvedValue({
      titles: { draft: { title: null, source: null } },
    });
    vi.mocked(setConversationTitle).mockRejectedValue(
      new ApiError(404, { code: 'thread_not_found' }, 'Not durable'),
    );
    await renderHook(workspaceWith(chat('draft')));
    for (const delay of retryDelays) await advance(delay);
    expect(setConversationTitle).toHaveBeenCalledTimes(6);
    await advance(300000);
    expect(setConversationTitle).toHaveBeenCalledTimes(6);
    expect(getConversationTitle('canvas', 'draft').title).toBe('Manual draft');
    vi.mocked(setConversationTitle).mockResolvedValue({
      title: 'Manual draft',
      source: 'user',
    });
    await focus();
    expect(setConversationTitle).toHaveBeenCalledTimes(7);
    expect(useConversationTitleStore.getState().pending).toEqual({});
  });

  it('batches every open chat, including cold tabs, by canvas and excludes node targets', async () => {
    query.mockImplementation(async ({ canvasId, threadIds }) =>
      response(threadIds, 'generated', canvasId),
    );
    let workspace = workspaceWith(
      chat('cold-1'),
      chat('cold-2'),
      chat('warm'),
      chat('active'),
    );
    workspace = openTarget(
      workspace,
      chat('cold-1', 'other-canvas'),
      { openToSide: true },
      { tabId: 'other-chat', groupId: 'secondary' },
    ).workspace;
    workspace = openTarget(
      workspace,
      { kind: 'node', canvasId: 'canvas', nodeId: 'question-node' },
      {},
      { tabId: 'node-tab' },
    ).workspace;
    useConversationTitleStore.setState({
      entries: {
        [conversationTitleKey('canvas', 'closed-chat')]: {
          value: { title: 'Not open', source: 'fallback' },
          revision: 0,
          durable: true,
        },
      },
    });

    await renderHook(workspace);

    expect(query.mock.calls.map(([body]) => body)).toEqual([
      {
        canvasId: 'canvas',
        threadIds: ['active', 'cold-1', 'cold-2', 'warm'],
      },
      { canvasId: 'other-canvas', threadIds: ['cold-1'] },
    ]);
    for (const id of ['active', 'cold-1', 'cold-2', 'warm']) {
      expect(getConversationTitle('canvas', id)).toEqual({
        title: `canvas ${id}`,
        source: 'generated',
      });
    }
    expect(getConversationTitle('other-canvas', 'cold-1').title).toBe(
      'other-canvas cold-1',
    );
    expect(getConversationTitle('canvas', 'closed-chat').title).toBe(
      'Not open',
    );
    expect(vi.mocked(setConversationTitle)).not.toHaveBeenCalled();
  });

  it.each(['empty', 'nodes only'])(
    'does not query a workspace with %s targets',
    async (kind) => {
      const workspace =
        kind === 'empty'
          ? createEmptyWorkspace('primary')
          : workspaceWith({
              kind: 'node',
              canvasId: 'canvas',
              nodeId: 'question',
            });
      await renderHook(workspace);
      await advance(200000);
      await focus();
      expect(query).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not refetch for activation or tab insertion-order changes with identical targets', async () => {
    const workspace = workspaceWith(chat('a'), chat('b'));
    const hook = await renderHook(workspace);
    await advance(500);
    const activated = activateTab(workspace, 'tab-0');
    await hook.rerender({
      ...activated,
      tabs: Object.fromEntries(Object.entries(activated.tabs).reverse()),
    });
    expect(query).toHaveBeenCalledTimes(1);
    await advance(500);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith({
      canvasId: 'canvas',
      threadIds: ['a', 'b'],
    });
  });

  it('deduplicates overlapping in-flight batches across target changes, focus, and timers', async () => {
    const first = deferredResponse();
    const added = deferredResponse();
    query.mockReturnValueOnce(first.promise).mockReturnValueOnce(added.promise);
    const hook = await renderHook(workspaceWith(chat('a')));
    await hook.rerender(workspaceWith(chat('a'), chat('b')));
    await focus();
    await focus();
    await advance(10000);
    expect(query.mock.calls.map(([body]) => body)).toEqual([
      { canvasId: 'canvas', threadIds: ['a'] },
      { canvasId: 'canvas', threadIds: ['b'] },
    ]);

    await act(async () => {
      first.resolve(response(['a']));
      added.resolve(response(['b']));
    });
    // Only the latest effect may schedule polling after the old request settles.
    expect(vi.getTimerCount()).toBe(1);
    await advance(999);
    expect(query).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith({
      canvasId: 'canvas',
      threadIds: ['a', 'b'],
    });
    expect(getConversationTitle('canvas', 'a').source).toBe('fallback');
    expect(getConversationTitle('canvas', 'b').source).toBe('fallback');
  });

  it('replaces a backend fallback on a delayed poll and polls only unresolved titles', async () => {
    const initial = deferredResponse();
    query
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(response(['pending']))
      .mockResolvedValueOnce(response(['pending'], 'generated', 'Generated'));
    await renderHook(workspaceWith(chat('pending'), chat('established')));
    expect(getConversationTitle('canvas', 'pending')).toEqual({
      title: null,
      source: null,
    });
    await act(async () => {
      initial.resolve({
        titles: {
          pending: { title: 'First prompt', source: 'fallback' },
          established: { title: 'Already named', source: 'generated' },
        },
      });
    });
    await advance(999);
    expect(query).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(query).toHaveBeenLastCalledWith({
      canvasId: 'canvas',
      threadIds: ['pending'],
    });
    expect(getConversationTitle('canvas', 'pending').source).toBe('fallback');
    await advance(2999);
    expect(query).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getConversationTitle('canvas', 'pending')).toEqual({
      title: 'Generated pending',
      source: 'generated',
    });
    await advance(200000);
    expect(query).toHaveBeenCalledTimes(3);
    expect(getConversationTitle('canvas', 'established').title).toBe(
      'Already named',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['fallback', 'acp', 'failure'] as const)(
    'ends the retry window for persistent %s responses',
    async (kind) => {
      if (kind === 'failure') query.mockRejectedValue(new Error('Offline'));
      else
        query.mockImplementation(async ({ threadIds }) =>
          response(threadIds, kind),
        );
      await renderHook(workspaceWith(chat('pending')));
      expect(query).toHaveBeenCalledTimes(1);
      for (const [index, delay] of retryDelays.entries()) {
        await advance(delay - 1);
        expect(query).toHaveBeenCalledTimes(index + 1);
        await advance(1);
        expect(query).toHaveBeenCalledTimes(index + 2);
      }
      expect(vi.getTimerCount()).toBe(0);
      await advance(86400000);
      expect(query).toHaveBeenCalledTimes(6);
      if (kind === 'failure') {
        expect(
          useConversationTitleStore.getState().entries[
            conversationTitleKey('canvas', 'pending')
          ].error,
        ).toBe('Offline');
      } else {
        expect(getConversationTitle('canvas', 'pending').source).toBe(kind);
      }
    },
  );

  it.each(['fallback', 'acp'] as const)(
    'restarts exhausted %s polling through the real post-stream refreshEpoch action',
    async (source) => {
      query.mockImplementation(async ({ threadIds }) =>
        response(threadIds, source),
      );
      const workspace = workspaceWith(chat('pending'));
      await renderHook(workspace);
      await advance(200000);
      expect(query).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(0);

      const postStream = deferredResponse();
      query
        .mockReturnValueOnce(postStream.promise)
        .mockResolvedValueOnce(
          response(['pending'], 'generated', 'After stream'),
        );
      const epoch = useConversationTitleStore.getState().refreshEpoch;
      await act(async () => {
        refreshConversationTitleAfterStream('canvas', 'pending');
      });
      expect(useConversationTitleStore.getState().refreshEpoch).toBe(epoch + 1);
      expect(query).toHaveBeenCalledTimes(7);
      await act(async () => postStream.resolve(response(['pending'], source)));
      expect(getConversationTitle('canvas', 'pending').source).toBe(source);
      await advance(999);
      expect(query).toHaveBeenCalledTimes(7);
      await advance(1);
      expect(query).toHaveBeenCalledTimes(8);
      expect(getConversationTitle('canvas', 'pending')).toEqual({
        title: 'After stream pending',
        source: 'generated',
      });
      await advance(200000);
      expect(query).toHaveBeenCalledTimes(8);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['canvas', 'other-canvas'])(
    'does not query settled unrelated chats in %s after another chat streams',
    async (otherCanvas) => {
      query.mockImplementation(async ({ threadIds }) =>
        response(threadIds, 'generated'),
      );
      await renderHook(workspaceWith(chat('a'), chat('b', otherCanvas)));
      await advance(200000);
      query.mockClear();

      await act(async () => refreshConversationTitleAfterStream('canvas', 'a'));
      expect(query.mock.calls.map(([body]) => body)).toEqual([
        { canvasId: 'canvas', threadIds: ['a'] },
      ]);
      await advance(200000);
      expect(query).toHaveBeenCalledTimes(1);
      expect(getConversationTitle(otherCanvas, 'b').source).toBe('generated');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('retries late generation after an epoch without reading a settled cold chat', async () => {
    query.mockResolvedValue({
      titles: {
        a: { title: 'First prompt', source: 'fallback' },
        b: { title: 'Settled cold chat', source: 'user' },
      },
    });
    await renderHook(workspaceWith(chat('b'), chat('warm'), chat('a')));
    await advance(200000);
    query.mockClear();
    const postStream = deferredResponse();
    query
      .mockReturnValueOnce(postStream.promise)
      .mockResolvedValueOnce(response(['a']))
      .mockResolvedValueOnce(response(['a'], 'generated', 'Late title'));

    await act(async () => refreshConversationTitleAfterStream('canvas', 'a'));
    expect(query.mock.calls.map(([body]) => body)).toEqual([
      { canvasId: 'canvas', threadIds: ['a'] },
    ]);
    await act(async () => postStream.resolve(response(['a'])));
    await advance(999);
    expect(query).toHaveBeenCalledTimes(1);
    await advance(1);
    await advance(3000);
    expect(getConversationTitle('canvas', 'a')).toEqual({
      title: 'Late title a',
      source: 'generated',
    });
    await advance(200000);
    expect(query.mock.calls.map(([body]) => body)).toEqual(
      Array.from({ length: 3 }, () => ({
        canvasId: 'canvas',
        threadIds: ['a'],
      })),
    );
    expect(getConversationTitle('canvas', 'b').title).toBe('Settled cold chat');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps pending 404 retries finite after an epoch without querying settled chats', async () => {
    const key = conversationTitleKey('canvas', 'draft');
    useConversationTitleStore.setState({ pending: { [key]: 'Manual draft' } });
    query.mockResolvedValue({
      titles: {
        draft: { title: null, source: null },
        settled: { title: 'Settled', source: 'generated' },
      },
    });
    vi.mocked(setConversationTitle).mockRejectedValue(
      new ApiError(404, { code: 'thread_not_found' }, 'Not durable'),
    );
    await renderHook(workspaceWith(chat('draft'), chat('settled')));
    await advance(200000);
    query.mockClear();
    vi.mocked(setConversationTitle).mockClear();

    await act(async () =>
      refreshConversationTitleAfterStream('canvas', 'draft'),
    );
    // The stream path flushes first, then its query retries pending intent.
    expect(setConversationTitle).toHaveBeenCalledTimes(2);
    for (const delay of retryDelays) await advance(delay);
    expect(setConversationTitle).toHaveBeenCalledTimes(7);
    expect(query.mock.calls.map(([body]) => body)).toEqual(
      Array.from({ length: 6 }, () => ({
        canvasId: 'canvas',
        threadIds: ['draft'],
      })),
    );
    await advance(86400000);
    expect(setConversationTitle).toHaveBeenCalledTimes(7);
    expect(query).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
    expect(getConversationTitle('canvas', 'draft').title).toBe('Manual draft');
    expect(useConversationTitleStore.getState().pending[key]).toBe(
      'Manual draft',
    );
  });

  it('cancels the previous retry timer when a stream refresh starts a new window', async () => {
    await renderHook(workspaceWith(chat('pending')));
    await advance(500);
    const postStream = deferredResponse();
    query.mockReturnValueOnce(postStream.promise);
    await act(async () =>
      refreshConversationTitleAfterStream('canvas', 'pending'),
    );
    await act(async () => postStream.resolve(response(['pending'])));
    expect(query).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await advance(500);
    expect(query).toHaveBeenCalledTimes(2);
    await advance(500);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('removes closed chats from both polling and focus refreshes', async () => {
    const workspace = workspaceWith(chat('closed'), chat('remaining'));
    const hook = await renderHook(workspace);
    await hook.rerender(closeTab(workspace, 'tab-0'));
    await advance(1000);
    await focus();
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.slice(1).map(([body]) => body)).toEqual(
      Array.from({ length: 3 }, () => ({
        canvasId: 'canvas',
        threadIds: ['remaining'],
      })),
    );
  });

  it.each(['scheduled', 'in flight'])(
    'stops polling and focus refreshes on unmount with work %s',
    async (kind) => {
      const pending = kind === 'in flight' ? deferredResponse() : undefined;
      if (pending) query.mockReturnValueOnce(pending.promise);
      const hook = await renderHook(workspaceWith(chat('pending')));
      expect(vi.getTimerCount()).toBe(pending ? 0 : 1);
      hook.unmount();
      expect(vi.getTimerCount()).toBe(0);
      if (pending) {
        await act(async () => pending.resolve(response(['pending'])));
      }
      expect(vi.getTimerCount()).toBe(0);
      await focus();
      await advance(86400000);
      expect(query).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['generated', 'acp', 'user'] as const)(
    'refreshes established %s names on focus even after polling ends',
    async (source) => {
      query.mockResolvedValue(response(['named'], source, 'Original'));
      await renderHook(workspaceWith(chat('named')));
      await advance(200000);
      const initialCalls = source === 'acp' ? 6 : 1;
      expect(query).toHaveBeenCalledTimes(initialCalls);
      expect(vi.getTimerCount()).toBe(0);
      expect(getConversationTitle('canvas', 'named').title).toBe(
        'Original named',
      );
      query.mockResolvedValueOnce(
        response(['named'], source, 'Renamed elsewhere'),
      );
      await focus();
      expect(query).toHaveBeenCalledTimes(initialCalls + 1);
      expect(query).toHaveBeenLastCalledWith({
        canvasId: 'canvas',
        threadIds: ['named'],
      });
      expect(getConversationTitle('canvas', 'named')).toEqual({
        title: 'Renamed elsewhere named',
        source,
      });
    },
  );
});
