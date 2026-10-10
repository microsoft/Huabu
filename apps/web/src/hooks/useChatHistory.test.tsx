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

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatStore } from '@/store/chatStore';
import {
  conversationTitleKey,
  getConversationTitle,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';

import { claimAgentStream } from './agentStreamCoordinator';
import { useChatHistory } from './useChatHistory';

import type { ChatSession } from './useChatSession';
import type {
  AgentStreamAttachResult,
  AgentStreamCallbacks,
} from '@/api/agent';
import type { InkInterpretation } from '@huabu/shared';

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
  latestLoadOlderHistory = useChatHistory(
    session,
    noopSetIsLoading,
  ).loadOlderHistory;
  return null;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let latestLoadOlderHistory: (() => void) | undefined;

/** History ends on a user turn: the state that arms the reconnect. */
function seedStore(isStreaming: boolean) {
  useChatStore.setState({
    threadMap: { [CANVAS_ID]: THREAD_ID },
    threadsById: {
      [THREAD_ID]: {
        messages: [{ id: 'm1', role: 'user', content: 'hi' }],
        draft: '',
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
  latestLoadOlderHistory = undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('useChatHistory paging', () => {
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
              { role: 'assistant', content: 'Answer' },
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

  it('hydrates only the configured newest page with stable message IDs', async () => {
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
            { role: 'assistant', content: 'answer' },
          ],
        },
      ],
      before: 'older-cursor',
      hasMore: true,
    });

    await renderHarness();

    expect(apiMocks.fetchHistoryPage).toHaveBeenCalledWith(
      THREAD_ID,
      CANVAS_ID,
      3,
    );
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
    apiMocks.fetchHistoryPage
      .mockResolvedValueOnce({
        threadId: THREAD_ID,
        turns: [
          {
            id: 'turn-3',
            messages: [{ role: 'assistant', content: 'latest' }],
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
            messages: [{ role: 'assistant', content: 'cached' }],
          },
          {
            id: 'turn-2',
            messages: [{ role: 'assistant', content: 'middle' }],
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
  });
});
