// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The reconnect effect's own guard — "history ends with a user message" —
 * is also true for the whole lead time after a send, so it cannot tell a
 * page refresh (what reconnect is for) from a turn this client is already
 * streaming. `loadingThreadIds` is what separates them; these tests pin
 * both directions, because a guard that never lets the reconnect through
 * would pass the negative case for the wrong reason.
 */

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { useChatPreferencesStore } from '@/store/chatPreferencesStore';
import { selectThreadHistoryLoaded, useChatStore } from '@/store/chatStore';
import {
  conversationTitleKey,
  getConversationTitle,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';
import {
  messageListViewKey,
  readMessageListScrollBookmark,
  rememberMessageListScrollAnchor,
} from '@/store/previewWorkspace/scrollMemory';

import {
  claimAgentStream,
  hasAgentStreamClaim,
} from './agentStreamCoordinator';
import * as turnController from './agentTurnController';
import { useChatHistory, type ChatHistoryWindow } from './useChatHistory';

import type { ChatSession } from './useChatSession';
import type {
  AgentStreamAttachResult,
  AgentStreamCallbacks,
} from '@/api/agent';
import type { AgentConversationView, InkInterpretation } from '@huabu/shared';

const apiMocks = vi.hoisted(() => ({
  fetchHistoryPage: vi.fn(),
  reconnectStream: vi.fn(
    async (
      _threadId: string,
      _canvasId: string,
      _callbacks: AgentStreamCallbacks,
    ): Promise<AgentStreamAttachResult> => ({ status: 'inactive' }),
  ),
  patchOwner: vi.fn(),
  remoteSource: undefined as
    | { status: string; invocationToken: string }
    | undefined,
}));

const canvasMock = vi.hoisted(() => ({
  state: {
    canvasId: 'canvas-1',
    nodes: [] as Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
    }>,
    patchNodeSilent: vi.fn(),
  },
}));

vi.mock('@/api/agent', () => ({
  agentApi: {
    fetchHistoryPage: apiMocks.fetchHistoryPage,
    reconnectStream: apiMocks.reconnectStream,
  },
}));

vi.mock('@/store/canvasStore', () => {
  const useCanvasStore = (selector: (s: typeof canvasMock.state) => unknown) =>
    selector(canvasMock.state);
  useCanvasStore.getState = () => canvasMock.state;
  return { default: useCanvasStore };
});

vi.mock('./useAgentStream', () => ({ handleStreamEvent: vi.fn() }));
vi.mock('@/api/conversationTitles', () => ({
  queryConversationTitles: async () => ({ titles: {} }),
  setConversationTitle: vi.fn(),
}));

vi.mock('@/store/conversationOwner', () => ({
  ConversationIntegrityError: class ConversationIntegrityError extends Error {},
  filterClientOwnedQuestionPatch: vi.fn(
    (_source: unknown, patch: Record<string, unknown>) => patch,
  ),
  patchConversationOwnerNode: apiMocks.patchOwner,
  resolveConversationOwnerSource: vi.fn(() => undefined),
  useConversationOwnerSource: (view: AgentConversationView | null) => {
    if (view?.conversationOwner.canvasId === 'remote')
      return apiMocks.remoteSource;
    if (!view || view.conversationOwner.canvasId !== canvasMock.state.canvasId)
      return undefined;
    return canvasMock.state.nodes.find(
      (node) => node.id === view.conversationOwner.nodeId,
    )?.data;
  },
  validateConversationView: vi.fn(async () => {}),
}));

vi.mock('@/hooks/useActivelyViewingQuestion', () => ({
  isActivelyViewingQuestion: vi.fn(() => false),
}));

vi.mock('@/store/acpThreadChangesStore', () => ({
  useAcpThreadChangesStore: {
    getState: () => ({ load: vi.fn().mockResolvedValue(undefined) }),
  },
}));

const THREAD_ID = 'thread-1';
const CANVAS_ID = 'canvas-1';

/** Stable identity — the effect lists it as a dependency. */
const noopSetIsLoading = () => {};

/** Stable identity — the hook derives its effect dependencies from it. */
const SESSION: ChatSession = {
  threadId: THREAD_ID,
  canvasId: CANVAS_ID,
  ownerCanvasId: CANVAS_ID,
  conversationView: null,
};

function Harness({ session = SESSION }: { session?: ChatSession }) {
  const history = useChatHistory(session, noopSetIsLoading);
  latestHistory = history;
  latestLoadOlderHistory = history.loadOlderHistory;
  latestRetryHistory = history.retryHistory;
  latestOwnerHistoryReady = history.isCurrentOwnerHistory;
  return null;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let latestLoadOlderHistory: (() => void) | undefined;
let latestRetryHistory: (() => void) | undefined;
let latestHistory: ChatHistoryWindow;
let latestOwnerHistoryReady = false;

/** History ends on a user turn: the state that arms the reconnect. */
function seedStore(isStreaming: boolean) {
  useChatStore.setState({
    threadMap: { [CANVAS_ID]: THREAD_ID },
    threadsById: {
      [THREAD_ID]: {
        messages: [{ id: 'm1', role: 'user', content: 'hi' }],
        draft: '',
        pendingQuotedComments: [],
        excludeCanvasSelection: false,
        historyLoaded: true,
        historyBefore: null,
        hasOlderHistory: false,
        isLoadingOlderHistory: false,
        olderHistoryError: null,
        isStreaming,
        lastAction: 'ask',
        binding: { kind: 'internal' },
        settings: { modelId: null, reasoningEffort: null },
        pendingAttachments: [],
        queuedTurns: [],
        queuePaused: false,
      },
    },
  });
}

async function renderHarness(session: ChatSession = SESSION): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness session={session} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useConversationTitleStore.setState({
    entries: {},
    pending: {},
    refreshEpoch: 0,
  });
  useChatStore.persist.setOptions({
    storage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  apiMocks.fetchHistoryPage.mockReset();
  apiMocks.fetchHistoryPage.mockResolvedValue({
    threadId: THREAD_ID,
    turns: [
      {
        id: 'turn-1',
        messages: [{ role: 'user', content: 'hi' }],
      },
    ],
    hasMore: false,
  });
  apiMocks.reconnectStream.mockReset();
  apiMocks.reconnectStream.mockResolvedValue({ status: 'inactive' });
  canvasMock.state.nodes = [];
  canvasMock.state.patchNodeSilent.mockClear();
  apiMocks.patchOwner.mockClear();
  apiMocks.remoteSource = undefined;
  latestLoadOlderHistory = undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

describe('bounded history refill and completion', () => {
  function seedPages() {
    seedStore(false);
    const state = useChatStore.getState();
    state.setMessages(THREAD_ID, [
      {
        id: 'latest:1',
        historyTurnId: 'latest',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'Latest answer' }],
      },
    ]);
    const page = {
      before: 'older-page',
      limit: 2,
      messageIds: ['old:0', 'old:1'],
      loaded: false,
    };
    state.setHistoryPages(THREAD_ID, [
      page,
      { limit: 3, messageIds: ['latest:1'], loaded: true },
    ]);
    return page;
  }

  it('pauses every visible page refill after failures until explicit Retry', async () => {
    const first = seedPages();
    const second = {
      ...first,
      before: 'another-page',
      messageIds: ['other:0', 'other:1'],
    };
    const pages = [first, second];
    useChatStore
      .getState()
      .setHistoryPages(THREAD_ID, [
        ...pages,
        { limit: 3, messageIds: ['latest:1'], loaded: true },
      ]);
    // Bound a regression's retry loop so the test fails instead of hanging.
    apiMocks.fetchHistoryPage.mockImplementation(() =>
      apiMocks.fetchHistoryPage.mock.calls.length <= 8
        ? Promise.reject(new Error('offline'))
        : new Promise(() => {}),
    );
    function VisiblePages() {
      const history = useChatHistory(SESSION, noopSetIsLoading);
      latestHistory = history;
      useEffect(() => {
        pages.forEach(history.loadHistoryPage);
      }, [history.loadHistoryPage]);
      return null;
    }
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<VisiblePages />));
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledTimes(2);
    expect(latestHistory.historyPageError).toBe('offline');
    await act(async () => pages.forEach(latestHistory.loadHistoryPage));
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledTimes(2);
    expect(
      useChatStore.getState().threadsById[THREAD_ID]?.messages,
    ).toHaveLength(1);

    await act(async () => latestHistory.retryHistoryPage());
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledTimes(4);
    expect(latestHistory.historyPageError).toBe('offline');
    apiMocks.fetchHistoryPage.mockImplementation(
      async (_threadId, _canvasId, _limit, before) => ({
        threadId: THREAD_ID,
        turns: [
          {
            id: before === 'older-page' ? 'old' : 'other',
            messages: [
              { role: 'user', content: 'Old question' },
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: 'Old answer' }],
              },
            ],
          },
        ],
        hasMore: false,
      }),
    );
    await act(async () => latestHistory.retryHistoryPage());
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledTimes(6);
    expect(latestHistory.historyPageError).toBeUndefined();
    expect(
      useChatStore
        .getState()
        .threadsById[THREAD_ID]?.messages.map((message) => message.id),
    ).toEqual(['old:0', 'old:1', 'other:0', 'other:1', 'latest:1']);
  });

  it('deduplicates page refills and reuses the original page size and cursor', async () => {
    const page = seedPages();
    let resolve!: (value: unknown) => void;
    apiMocks.fetchHistoryPage.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderHarness();
    act(() => {
      latestHistory.loadHistoryPage(page);
      latestHistory.loadHistoryPage(page);
    });
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledExactlyOnceWith(
      THREAD_ID,
      CANVAS_ID,
      2,
      'older-page',
    );
    await act(async () =>
      resolve({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'old',
            messages: [
              { role: 'user', content: 'Old question' },
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: 'Old answer' }],
              },
            ],
          },
        ],
        hasMore: false,
      }),
    );
    expect(
      useChatStore
        .getState()
        .threadsById[THREAD_ID]?.messages.map((message) => message.id),
    ).toEqual(['old:0', 'old:1', 'latest:1']);
  });

  it('keeps visible history on a stale cursor until an explicit reload retry', async () => {
    const page = seedPages();
    apiMocks.fetchHistoryPage.mockRejectedValueOnce(
      new ApiError(409, { message: 'History changed' }, 'History changed'),
    );
    await renderHarness();
    await act(async () => latestHistory.loadHistoryPage(page));
    expect(latestHistory.historyPageError).toBe('History changed');
    expect(
      useChatStore.getState().threadsById[THREAD_ID]?.messages[0]?.id,
    ).toBe('latest:1');
    apiMocks.fetchHistoryPage.mockResolvedValue({
      threadId: THREAD_ID,
      turns: [
        {
          id: 'replacement',
          messages: [
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'New generation' }],
            },
          ],
        },
      ],
      hasMore: false,
    });
    await act(async () => latestHistory.retryHistoryPage());
    expect(
      useChatStore.getState().threadsById[THREAD_ID]?.messages[0]?.id,
    ).toBe('replacement:0');
    expect(
      useChatStore.getState().threadsById[THREAD_ID]?.historyPages,
    ).toHaveLength(1);
  });

  it.each(['failure', 'stale failure', 'mismatched success'] as const)(
    'ignores obsolete refill %s after successful reload and permits new refills',
    async (outcome) => {
      const first = seedPages();
      const second = {
        ...first,
        before: 'second-old',
        messageIds: ['second:0'],
      };
      useChatStore
        .getState()
        .setHistoryPages(THREAD_ID, [
          first,
          second,
          { limit: 3, messageIds: ['latest:1'], loaded: true },
        ]);
      let rejectLate!: (error: Error) => void;
      let resolveLate!: (response: unknown) => void;
      apiMocks.fetchHistoryPage
        .mockRejectedValueOnce(
          new ApiError(409, { message: 'History changed' }, 'History changed'),
        )
        .mockReturnValueOnce(
          new Promise((resolve, reject) => {
            resolveLate = resolve;
            rejectLate = reject;
          }),
        );
      await renderHarness();
      await act(async () => {
        latestHistory.loadHistoryPage(first);
        latestHistory.loadHistoryPage(second);
      });
      apiMocks.fetchHistoryPage.mockResolvedValue({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'replacement',
            messages: [
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: 'Fresh history' }],
              },
            ],
          },
        ],
        hasMore: false,
      });
      await act(async () => latestHistory.retryHistoryPage());
      expect(latestHistory.historyPageError).toBeUndefined();
      await act(async () => {
        if (outcome === 'failure') rejectLate(new Error('Old request failed'));
        else if (outcome === 'stale failure')
          rejectLate(
            new ApiError(409, { message: 'Old cursor' }, 'Old cursor'),
          );
        else resolveLate({ threadId: THREAD_ID, turns: [], hasMore: false });
      });
      expect(latestHistory.historyPageError).toBeUndefined();
      expect(
        useChatStore.getState().threadsById[THREAD_ID]?.messages[0]?.id,
      ).toBe('replacement:0');
      apiMocks.fetchHistoryPage.mockClear();
      await act(async () => latestHistory.retryHistoryPage());
      expect(apiMocks.fetchHistoryPage).not.toHaveBeenCalled();
      const newPage = {
        before: 'fresh-older',
        limit: 3,
        messageIds: ['fresh:0'],
        loaded: false,
      };
      useChatStore
        .getState()
        .setHistoryPages(THREAD_ID, [
          newPage,
          { limit: 3, messageIds: ['replacement:0'], loaded: true },
        ]);
      apiMocks.fetchHistoryPage.mockResolvedValue({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'fresh',
            messages: [
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: 'Older answer' }],
              },
            ],
          },
        ],
        hasMore: false,
      });
      await act(async () => latestHistory.loadHistoryPage(newPage));
      expect(apiMocks.fetchHistoryPage).toHaveBeenCalledOnce();
      expect(
        useChatStore
          .getState()
          .threadsById[THREAD_ID]?.messages.map((message) => message.id),
      ).toEqual(['fresh:0', 'replacement:0']);
    },
  );

  it.each(['failure', 'success'] as const)(
    'ignores refill %s when revision changes even if the page object is retained',
    async (outcome) => {
      const page = seedPages();
      let resolveLate!: (response: unknown) => void;
      let rejectLate!: (error: Error) => void;
      apiMocks.fetchHistoryPage.mockReturnValue(
        new Promise((resolve, reject) => {
          resolveLate = resolve;
          rejectLate = reject;
        }),
      );
      await renderHarness();
      act(() => latestHistory.loadHistoryPage(page));
      useChatStore.setState((state) => {
        const thread = state.threadsById[THREAD_ID];
        if (!thread) throw new Error('Missing thread');
        return {
          threadsById: {
            ...state.threadsById,
            [THREAD_ID]: {
              ...thread,
              historyRevision: (thread.historyRevision ?? 0) + 1,
            },
          },
        };
      });
      await act(async () => {
        if (outcome === 'failure') rejectLate(new Error('Obsolete request'));
        else
          resolveLate({
            threadId: THREAD_ID,
            turns: [
              {
                id: 'old',
                messages: [
                  { role: 'user', content: 'Old question' },
                  {
                    role: 'assistant',
                    parts: [{ kind: 'text', text: 'Old answer' }],
                  },
                ],
              },
            ],
            hasMore: false,
          });
      });
      expect(latestHistory.historyPageError).toBeUndefined();
      expect(
        useChatStore
          .getState()
          .threadsById[THREAD_ID]?.messages.map((message) => message.id),
      ).toEqual(['latest:1']);
      expect(
        useChatStore.getState().threadsById[THREAD_ID]?.historyPages?.[0],
      ).toBe(page);
    },
  );

  it('does not drop a completed local tail before the server has persisted it', async () => {
    seedPages();
    useChatStore.getState().addMessage(THREAD_ID, {
      id: 'live-user',
      role: 'user',
      content: 'New question',
    });
    useChatStore.getState().addMessage(THREAD_ID, {
      id: 'live-answer',
      role: 'assistant',
      segments: [{ kind: 'text', text: 'New answer' }],
    });
    const scrollRoot = document.createElement('div');
    const row = document.createElement('div');
    row.dataset.chatMessageId = 'live-answer';
    row.getBoundingClientRect = () => new DOMRect(0, 20, 100, 100);
    scrollRoot.append(row);
    const viewKey = messageListViewKey(CANVAS_ID, THREAD_ID);
    rememberMessageListScrollAnchor(scrollRoot, viewKey);
    apiMocks.fetchHistoryPage.mockResolvedValue({
      threadId: THREAD_ID,
      turns: [
        {
          id: 'latest',
          messages: [
            { role: 'user', content: 'Old question' },
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'Latest answer' }],
            },
          ],
        },
      ],
      hasMore: false,
    });
    await renderHarness();
    await act(async () =>
      useChatStore.getState().markTurnCompleted(THREAD_ID, 'live-answer'),
    );
    expect(
      useChatStore.getState().threadsById[THREAD_ID]?.messages.at(-1)?.id,
    ).toBe('live-answer');
    expect(latestHistory.historyPageError).toContain(
      'not available in history',
    );
    apiMocks.fetchHistoryPage.mockResolvedValue({
      threadId: THREAD_ID,
      turns: [
        {
          id: 'latest',
          messages: [
            { role: 'user', content: 'Old question' },
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'Latest answer' }],
            },
          ],
        },
        {
          id: 'completed',
          messages: [
            { role: 'user', content: 'New question' },
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'New answer' }],
            },
          ],
        },
      ],
      hasMore: false,
    });
    await act(async () => latestHistory.retryHistoryPage());
    expect(
      useChatStore.getState().threadsById[THREAD_ID]?.messages.at(-1)?.id,
    ).toBe('completed:1');
    expect(latestHistory.historyPageError).toBeUndefined();
    expect(readMessageListScrollBookmark(viewKey)).toEqual({
      messageId: 'completed:1',
      offsetTop: 20,
    });
  });
});

describe('useChatHistory paging', () => {
  it('refreshes a new terminal invocation without observing running, preserving older pages', async () => {
    seedStore(false);
    useChatStore.getState().setMessages(THREAD_ID, [
      {
        id: 'old:0',
        historyTurnId: 'old',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'Old answer' }],
      },
    ]);
    const session: ChatSession = {
      ...SESSION,
      ownerCanvasId: 'remote',
      conversationView: {
        presentationAnchor: { canvasId: 'remote', nodeId: 'remote-node' },
        conversationOwner: {
          canvasId: 'remote',
          nodeId: 'remote-node',
          threadId: THREAD_ID,
        },
      },
    };
    apiMocks.remoteSource = { status: 'done', invocationToken: 'old-run' };
    apiMocks.fetchHistoryPage.mockResolvedValue({
      threadId: THREAD_ID,
      hasMore: false,
      turns: [
        {
          id: 'old',
          messages: [
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'Old answer' }],
            },
          ],
        },
      ],
    });
    await renderHarness(session);
    expect(latestOwnerHistoryReady).toBe(true);
    apiMocks.fetchHistoryPage.mockClear();
    const updatedPage = {
      threadId: THREAD_ID,
      hasMore: false,
      turns: [
        {
          id: 'old',
          messages: [
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'Old answer' }],
            },
          ],
        },
        {
          id: 'new',
          messages: [
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'New answer' }],
            },
          ],
        },
      ],
    };
    let finishRefresh: ((value: typeof updatedPage) => void) | undefined;
    apiMocks.fetchHistoryPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    apiMocks.remoteSource = { status: 'done', invocationToken: 'new-run' };
    await act(async () => root?.render(<Harness session={session} />));
    expect(latestOwnerHistoryReady).toBe(false);
    await act(async () => finishRefresh?.(updatedPage));
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledWith(
      THREAD_ID,
      'remote',
      3,
    );
    expect(
      useChatStore
        .getState()
        .threadsById[THREAD_ID]?.messages.map((m) => m.historyTurnId),
    ).toEqual(['old', 'new']);
    expect(latestOwnerHistoryReady).toBe(true);
  });
  it.each(['completed', 'inactive'] as const)(
    'awaits request reconciliation before history refresh and queue settlement after %s attach',
    async (status) => {
      seedStore(false);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reconcile = vi
        .spyOn(turnController, 'reconcileAgentTurnAfterReconnect')
        .mockReturnValueOnce(pending);
      const settle = vi
        .spyOn(turnController, 'settleAgentTurnQueue')
        .mockImplementation(() => {
          expect(hasAgentStreamClaim(CANVAS_ID, THREAD_ID)).toBe(false);
        });
      apiMocks.reconnectStream.mockImplementationOnce(
        async (_thread, _canvas, callbacks) => {
          if (status === 'completed') {
            callbacks.onEvent({ type: 'done', data: { message: 'Answer' } });
            callbacks.onComplete();
          }
          return { status };
        },
      );
      try {
        await renderHarness();
        expect(reconcile).toHaveBeenCalledExactlyOnceWith(CANVAS_ID, THREAD_ID);
        expect(hasAgentStreamClaim(CANVAS_ID, THREAD_ID)).toBe(true);
        expect(settle).not.toHaveBeenCalled();
        expect(apiMocks.fetchHistoryPage).toHaveBeenCalledOnce();
        await act(async () => {
          release();
          await pending;
        });
        expect(apiMocks.fetchHistoryPage).toHaveBeenCalledTimes(2);
        expect(settle).toHaveBeenCalledOnce();
      } finally {
        release();
        reconcile.mockRestore();
        settle.mockRestore();
      }
    },
  );

  it('does not reconcile a cancelled attach', async () => {
    seedStore(false);
    const reconcile = vi.spyOn(
      turnController,
      'reconcileAgentTurnAfterReconnect',
    );
    apiMocks.reconnectStream.mockResolvedValueOnce({ status: 'aborted' });
    try {
      await renderHarness();
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      reconcile.mockRestore();
    }
  });

  it.each(['done', 'cancelled', 'error', 'close', 'aborted'])(
    'settles the queue only after releasing the reconnect claim: %s',
    async (terminal) => {
      seedStore(false);
      const settle = vi
        .spyOn(turnController, 'settleAgentTurnQueue')
        .mockImplementation((session, completed) => {
          expect(
            hasAgentStreamClaim(session.ownerCanvasId, session.threadId),
          ).toBe(false);
          expect(completed).toBe(terminal === 'done');
        });
      apiMocks.reconnectStream.mockImplementationOnce(
        async (_thread, _canvas, callbacks) => {
          if (terminal === 'error')
            callbacks.onError(new Error('Disconnected'));
          else {
            if (terminal !== 'close')
              callbacks.onEvent({
                type: 'done',
                data: {
                  message: '',
                  meta: {
                    stopReason: terminal === 'cancelled' ? 'cancelled' : 'stop',
                  },
                },
              });
            callbacks.onComplete();
          }
          return { status: terminal === 'aborted' ? 'aborted' : 'completed' };
        },
      );
      try {
        await renderHarness();
        expect(settle).toHaveBeenCalledOnce();
      } finally {
        settle.mockRestore();
      }
    },
  );

  it.each([false, true])(
    'does not request history for a newly created thread with node=%s',
    async (node) => {
      const threadId = useChatStore
        .getState()
        .createThread({ binding: { kind: 'internal' } });
      const session: ChatSession = {
        ...SESSION,
        threadId,
        conversationView: node
          ? {
              presentationAnchor: { canvasId: CANVAS_ID, nodeId: 'node-new' },
              conversationOwner: {
                canvasId: CANVAS_ID,
                nodeId: 'node-new',
                threadId,
              },
            }
          : null,
      };
      await renderHarness(session);
      expect(apiMocks.fetchHistoryPage).not.toHaveBeenCalled();
      expect(apiMocks.reconnectStream).not.toHaveBeenCalled();
    },
  );

  it('retains the draft and blocks sending after a failed initial load until explicit retry', async () => {
    useChatStore.setState({ threadsById: {} });
    useChatStore.getState().setDraft(THREAD_ID, 'Keep my draft');
    apiMocks.fetchHistoryPage.mockRejectedValueOnce(
      new Error('History unavailable'),
    );
    await renderHarness();
    expect(selectThreadHistoryLoaded(useChatStore.getState(), THREAD_ID)).toBe(
      false,
    );
    expect(useChatStore.getState().threadsById[THREAD_ID]).toMatchObject({
      draft: 'Keep my draft',
      historyError: 'History unavailable',
    });
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledOnce();
    apiMocks.fetchHistoryPage.mockResolvedValueOnce({
      threadId: THREAD_ID,
      turns: [],
      hasMore: false,
    });
    await act(async () => {
      latestRetryHistory?.();
    });
    expect(selectThreadHistoryLoaded(useChatStore.getState(), THREAD_ID)).toBe(
      true,
    );
    expect(useChatStore.getState().threadsById[THREAD_ID]).toMatchObject({
      draft: 'Keep my draft',
      historyError: null,
    });
  });

  it('retains the draft after invalidated history fails and retries without remounting', async () => {
    seedStore(false);
    const chat = useChatStore.getState();
    chat.setMessages(THREAD_ID, []);
    chat.setDraft(THREAD_ID, 'Unsent draft');
    await renderHarness();
    expect(apiMocks.fetchHistoryPage).not.toHaveBeenCalled();

    apiMocks.fetchHistoryPage.mockRejectedValueOnce(
      new Error('History unavailable'),
    );
    await act(async () => chat.setHistoryLoaded(THREAD_ID, false));
    expect(useChatStore.getState().threadsById[THREAD_ID]).toMatchObject({
      historyLoaded: false,
      historyError: 'History unavailable',
      draft: 'Unsent draft',
    });
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledOnce();
    apiMocks.fetchHistoryPage.mockResolvedValueOnce({
      threadId: THREAD_ID,
      turns: [],
      hasMore: false,
    });
    await act(async () => latestRetryHistory?.());
    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().threadsById[THREAD_ID]).toMatchObject({
      historyLoaded: true,
      historyError: null,
      draft: 'Unsent draft',
    });
    expect(apiMocks.reconnectStream).not.toHaveBeenCalled();
  });

  it('rehydrates quote-only user messages without regenerating template text', async () => {
    useChatStore.setState({ threadsById: {} });
    const quotedComments = [
      {
        quote: 'Original reply',
        contextBefore: 'Before ',
        contextAfter: ' after',
        comment: 'Explain this.',
      },
    ];
    apiMocks.fetchHistoryPage.mockResolvedValueOnce({
      threadId: THREAD_ID,
      turns: [
        {
          id: 'quoted-turn',
          messages: [
            { role: 'user', content: '', quotedComments },
            {
              role: 'assistant',
              parts: [{ kind: 'text', text: 'Explanation' }],
            },
          ],
        },
      ],
      hasMore: false,
    });
    await renderHarness();
    expect(
      useChatStore.getState().threadsById[THREAD_ID]?.messages[0],
    ).toMatchObject({
      role: 'user',
      content: '',
      quotedComments,
    });
  });

  it.each([null, 'Backend title'])(
    'does not derive a title from hydrated user messages with cached title %s',
    async (title) => {
      useChatStore.setState({
        threadMap: { [CANVAS_ID]: THREAD_ID },
        threadsById: {},
      });
      const value = title
        ? { title, source: 'generated' as const }
        : { title: null, source: null };
      useConversationTitleStore.setState({
        entries: {
          [conversationTitleKey(CANVAS_ID, THREAD_ID)]: {
            value,
            revision: 0,
            durable: true,
          },
        },
      });
      apiMocks.fetchHistoryPage.mockResolvedValueOnce({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'turn-1',
            messages: [
              {
                role: 'user',
                content: '# A heading that must not become a title',
              },
              { role: 'assistant', parts: [{ kind: 'text', text: 'Answer' }] },
            ],
          },
        ],
        hasMore: false,
      });
      await renderHarness();
      expect(
        useChatStore.getState().threadsById[THREAD_ID]?.messages,
      ).toHaveLength(2);
      expect(getConversationTitle(CANVAS_ID, THREAD_ID)).toEqual(value);
    },
  );

  it('uses the internal newest-page size regardless of legacy preferences', async () => {
    useChatStore.setState({
      threadMap: { [CANVAS_ID]: THREAD_ID },
      threadsById: {},
    });
    apiMocks.fetchHistoryPage.mockResolvedValueOnce({
      threadId: THREAD_ID,
      turns: [
        {
          id: 'turn-latest',
          messages: [
            { role: 'user', content: 'question' },
            { role: 'assistant', parts: [{ kind: 'text', text: 'answer' }] },
          ],
        },
      ],
      before: 'older-cursor',
      hasMore: true,
    });

    const previous = useChatPreferencesStore.getState().recentTurnCount;
    useChatPreferencesStore.getState().setRecentTurnCount(20);
    try {
      await renderHarness();
      expect(apiMocks.fetchHistoryPage).toHaveBeenCalledWith(
        THREAD_ID,
        CANVAS_ID,
        3,
      );
    } finally {
      useChatPreferencesStore.getState().setRecentTurnCount(previous);
    }
    const thread = useChatStore.getState().threadsById[THREAD_ID];
    expect(thread?.messages.map((message) => message.id)).toEqual([
      'turn-latest:0',
      'turn-latest:1',
    ]);
    expect(thread?.historyBefore).toBe('older-cursor');
    expect(thread?.hasOlderHistory).toBe(true);
  });

  it('prepends an older page and advances its exclusive cursor', async () => {
    seedStore(false);
    useChatStore.getState().setMessages(THREAD_ID, [
      {
        id: 'turn-2:0',
        historyTurnId: 'turn-2',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'newer' }],
      },
    ]);
    useChatStore.getState().setHistoryPageState(THREAD_ID, {
      before: 'cursor-2',
      hasOlder: true,
      loadingOlder: false,
      error: null,
    });
    apiMocks.fetchHistoryPage.mockResolvedValueOnce({
      threadId: THREAD_ID,
      turns: [
        {
          id: 'turn-1',
          messages: [{ role: 'user', content: 'older' }],
        },
      ],
      before: 'cursor-1',
      hasMore: true,
    });

    await renderHarness();
    await act(async () => {
      latestLoadOlderHistory?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledWith(
      THREAD_ID,
      CANVAS_ID,
      3,
      'cursor-2',
    );
    const thread = useChatStore.getState().threadsById[THREAD_ID];
    expect(thread?.messages.map((message) => message.id)).toEqual([
      'turn-1:0',
      'turn-2:0',
    ]);
    expect(thread?.historyBefore).toBe('cursor-1');
  });
});

describe('useChatHistory reconnect', () => {
  it.each([
    [
      {
        state: 'reported',
        text: 'Summarize the diagram',
        explanation: 'The circle encloses both notes.',
      },
      {
        state: 'reported',
        text: 'Summarize the diagram',
        explanation: 'The circle encloses both notes.',
      },
    ],
    [{ state: 'missing' }, { state: 'missing' }],
    [{ state: 'failed' }, { state: 'failed' }],
    [{ state: 'interrupted' }, { state: 'interrupted' }],
    [{ state: 'legacy' }, { state: 'legacy' }],
    [{ state: 'pending' }, { state: 'missing' }],
    [undefined, { state: 'legacy' }],
  ] as Array<[InkInterpretation | undefined, InkInterpretation]>)(
    'hydrates terminal Ink interpretation %j without false pending',
    async (inkInterpretation, expected) => {
      useChatStore.getState().setMessages(THREAD_ID, []);
      useChatStore.getState().setHistoryLoaded(THREAD_ID, false);
      apiMocks.fetchHistoryPage.mockResolvedValue({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'turn-ink',
            messages: [
              {
                role: 'user',
                content: '',
                inputKind: 'ink-intent',
                inkInterpretation,
                selectedNodeIds: ['sketch-1'],
                selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['s1'] }],
              },
              { role: 'assistant', parts: [{ kind: 'text', text: 'Done' }] },
            ],
          },
        ],
        hasMore: false,
      });
      await renderHarness();
      expect(
        useChatStore.getState().threadsById[THREAD_ID].messages[0],
      ).toMatchObject({
        content: '',
        inkInterpretation: expected,
        selectedNodeIds: ['sketch-1'],
        selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['s1'] }],
      });
      expect(apiMocks.reconnectStream).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['inactive', 'interrupted'],
    ['done', 'missing'],
    ['error', 'failed'],
    ['cancelled', 'interrupted'],
  ])(
    'settles active Ink after reconnect ends with %s',
    async (terminal, expectedState) => {
      useChatStore.getState().setMessages(THREAD_ID, []);
      useChatStore.getState().setHistoryLoaded(THREAD_ID, false);
      apiMocks.fetchHistoryPage.mockResolvedValue({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'active-ink',
            active: true,
            messages: [
              {
                role: 'user',
                content: '',
                inputKind: 'ink-intent',
                inkInterpretation: { state: 'pending' },
              },
            ],
          },
        ],
        hasMore: false,
      });
      apiMocks.reconnectStream.mockImplementationOnce(
        async (_thread, _canvas, callbacks) => {
          expect(
            useChatStore.getState().threadsById[THREAD_ID].messages[0],
          ).toMatchObject({ inkInterpretation: { state: 'pending' } });
          if (terminal === 'inactive') return { status: 'inactive' };
          if (terminal === 'error')
            callbacks.onError(new Error('Report stream failed'));
          else {
            callbacks.onEvent({
              type: 'done',
              data: {
                message: '',
                meta: {
                  stopReason:
                    terminal === 'cancelled' ? 'cancelled' : 'end_turn',
                },
              },
            });
            callbacks.onComplete();
          }
          return { status: 'completed' };
        },
      );
      await renderHarness();
      await vi.waitFor(() =>
        expect(
          useChatStore.getState().threadsById[THREAD_ID].messages[0],
        ).toMatchObject({
          content: '',
          inkInterpretation: { state: expectedState },
        }),
      );
    },
  );

  it('hydrates the durable Ink input kind and retry metadata', async () => {
    useChatStore.getState().setMessages(THREAD_ID, []);
    useChatStore.getState().setHistoryLoaded(THREAD_ID, false);
    apiMocks.fetchHistoryPage.mockResolvedValue({
      threadId: THREAD_ID,
      turns: [
        {
          id: 'turn-ink',
          messages: [
            {
              role: 'user',
              content: '',
              inputKind: 'ink-intent',
              inkInterpretation: { state: 'legacy' },
              selectedNodeIds: ['sketch-1'],
              selectedStrokeIds: [
                { nodeId: 'sketch-1', strokeIds: ['stroke-1'] },
              ],
              invokedSkills: ['review'],
            },
          ],
        },
      ],
      hasMore: false,
    });

    await renderHarness();

    await vi.waitFor(() =>
      expect(useChatStore.getState().threadsById[THREAD_ID].messages).toEqual([
        expect.objectContaining({
          role: 'user',
          content: '',
          inputKind: 'ink-intent',
          selectedNodeIds: ['sketch-1'],
          selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
          invokedSkills: ['review'],
        }),
      ]),
    );
  });

  it('skips reconnect while this client already owns a live consumer', async () => {
    seedStore(true);
    const claim = claimAgentStream(CANVAS_ID, THREAD_ID, 'post');

    await renderHarness();

    // Attaching here would replay the in-flight turn under a second
    // assistantId and render the answer twice.
    expect(apiMocks.reconnectStream).not.toHaveBeenCalled();
    claim?.release();
  });

  it('reconnects when no consumer is live, as after a page refresh', async () => {
    // The streaming flag sits outside `partialize`, so a real refresh
    // arrives here with it false.
    seedStore(false);

    await renderHarness();

    expect(apiMocks.reconnectStream).toHaveBeenCalledTimes(1);
    expect(apiMocks.reconnectStream).toHaveBeenCalledWith(
      THREAD_ID,
      CANVAS_ID,
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it.each([undefined, 'selectable', 'fixed'])(
    'observes a running %s Agent Node without history-based repair',
    async (policy) => {
      seedStore(false);
      useChatStore.getState().setMessages(THREAD_ID, [
        {
          id: 'prior-answer',
          role: 'assistant',
          segments: [{ kind: 'text', text: 'Previous answer' }],
        },
      ]);
      canvasMock.state.nodes = [
        {
          id: 'node-agent',
          type: 'question',
          data: {
            threadId: THREAD_ID,
            status: 'running',
            agentBindingPolicy: policy,
          },
        },
      ];
      const session: ChatSession = {
        ...SESSION,
        conversationView: {
          presentationAnchor: {
            canvasId: CANVAS_ID,
            nodeId: 'node-agent',
          },
          conversationOwner: {
            canvasId: CANVAS_ID,
            nodeId: 'node-agent',
            threadId: THREAD_ID,
          },
        },
      };

      await renderHarness(session);

      expect(apiMocks.fetchHistoryPage).toHaveBeenCalledWith(
        THREAD_ID,
        CANVAS_ID,
        3,
      );
      expect(apiMocks.reconnectStream).toHaveBeenCalledTimes(1);
      await act(async () =>
        apiMocks.reconnectStream.mock.calls[0][2].onComplete(),
      );
      expect(canvasMock.state.nodes[0].data.status).toBe('running');
      expect(canvasMock.state.patchNodeSilent).not.toHaveBeenCalled();
      expect(apiMocks.patchOwner).not.toHaveBeenCalled();
    },
  );

  it('reconnects when the newest page marks an assistant tail active', async () => {
    seedStore(false);
    useChatStore.getState().setMessages(THREAD_ID, [
      {
        id: 'turn-active:1',
        historyTurnId: 'turn-active',
        historyTurnActive: true,
        role: 'assistant',
        segments: [{ kind: 'text', text: 'partial answer' }],
      },
    ]);

    await renderHarness();

    expect(apiMocks.reconnectStream).toHaveBeenCalledTimes(1);
  });

  it('fetches backward to overlap before merging a reconnect refresh', async () => {
    seedStore(false);
    useChatStore.getState().setMessages(THREAD_ID, [
      {
        id: 'turn-1:0',
        historyTurnId: 'turn-1',
        role: 'assistant',
        segments: [{ kind: 'text', text: 'cached' }],
      },
      { id: 'live-user', role: 'user', content: 'new work' },
    ]);
    useChatStore
      .getState()
      .setHistoryPages(THREAD_ID, [
        { limit: 3, messageIds: ['turn-1:0'], loaded: true },
      ]);
    useChatStore.getState().setHistoryPageState(THREAD_ID, {
      before: 'older-than-1',
      hasOlder: true,
    });
    apiMocks.fetchHistoryPage
      .mockResolvedValueOnce({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'turn-3',
            messages: [
              { role: 'assistant', parts: [{ kind: 'text', text: 'latest' }] },
            ],
          },
        ],
        before: 'before-3',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'turn-1',
            messages: [
              { role: 'assistant', parts: [{ kind: 'text', text: 'cached' }] },
            ],
          },
          {
            id: 'turn-2',
            messages: [
              { role: 'assistant', parts: [{ kind: 'text', text: 'middle' }] },
            ],
          },
        ],
        hasMore: false,
      });
    apiMocks.reconnectStream.mockResolvedValueOnce({ status: 'aborted' });

    await renderHarness();

    expect(apiMocks.fetchHistoryPage).toHaveBeenNthCalledWith(
      2,
      THREAD_ID,
      CANVAS_ID,
      3,
      'before-3',
    );
    expect(
      useChatStore
        .getState()
        .threadsById[
          THREAD_ID
        ]?.messages.map((message) => message.historyTurnId),
    ).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(useChatStore.getState().threadsById[THREAD_ID]).toMatchObject({
      hasOlderHistory: false,
      historyBefore: null,
    });
  });
});
