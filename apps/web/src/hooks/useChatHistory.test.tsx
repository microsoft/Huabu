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

import { selectThreadHistoryLoaded, useChatStore } from '@/store/chatStore';
import {
  conversationTitleKey,
  getConversationTitle,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';

import {
  claimAgentStream,
  hasAgentStreamClaim,
} from './agentStreamCoordinator';
import * as turnController from './agentTurnController';
import { useChatHistory } from './useChatHistory';

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

function Harness({
  session = SESSION,
  setIsLoading = noopSetIsLoading,
}: {
  session?: ChatSession;
  setIsLoading?: (threadId: string, loading: boolean) => void;
}) {
  const history = useChatHistory(session, setIsLoading);
  latestLoadOlderHistory = history.loadOlderHistory;
  latestRetryHistory = history.retryHistory;
  latestOwnerHistoryReady = history.isCurrentOwnerHistory;
  return null;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let latestLoadOlderHistory: (() => void) | undefined;
let latestRetryHistory: (() => void) | undefined;
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

async function renderHarness(
  session: ChatSession = SESSION,
  setIsLoading: (threadId: string, loading: boolean) => void = noopSetIsLoading,
): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness session={session} setIsLoading={setIsLoading} />);
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
  apiMocks.remoteSource = undefined;
  latestLoadOlderHistory = undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('useChatHistory paging', () => {
  it.each([
    { status: 'done', pending: false },
    { status: 'running', pending: false },
    { status: 'running', pending: true },
  ])(
    'attaches a new remote invocation after $status with an old pending attachment: $pending',
    async ({ status, pending }) => {
      seedStore(false);
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
      apiMocks.remoteSource = { status, invocationToken: 'old-run' };
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
      let finishOld: ((result: AgentStreamAttachResult) => void) | undefined;
      if (pending) {
        apiMocks.reconnectStream.mockImplementationOnce(
          async (_thread, _canvas, callbacks) => {
            callbacks.onEvent({
              type: 'text_delta',
              data: { content: 'Old answer' },
            });
            return new Promise((resolve) => {
              finishOld = resolve;
            });
          },
        );
      }
      const setIsLoading = useChatStore.getState().setThreadLoading;
      await renderHarness(session, setIsLoading);
      apiMocks.reconnectStream.mockClear();
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
          {
            id: 'new',
            active: true,
            messages: [
              { role: 'user', content: 'New message from child Space' },
            ],
          },
        ],
      });
      let finishNew: ((result: AgentStreamAttachResult) => void) | undefined;
      apiMocks.reconnectStream.mockImplementationOnce(
        async (_thread, _canvas, callbacks) => {
          callbacks.onEvent({
            type: 'text_delta',
            data: { content: 'New reply' },
          });
          return new Promise((resolve) => {
            finishNew = resolve;
          });
        },
      );
      apiMocks.remoteSource = { status: 'running', invocationToken: 'new-run' };
      try {
        await act(async () =>
          root?.render(
            <Harness session={session} setIsLoading={setIsLoading} />,
          ),
        );
        expect(apiMocks.reconnectStream).toHaveBeenCalledTimes(1);
        expect(useChatStore.getState().threadsById[THREAD_ID].messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: 'New message from child Space',
            }),
          ]),
        );
        expect(useChatStore.getState().threadsById[THREAD_ID].isStreaming).toBe(
          true,
        );
        await act(async () =>
          useChatStore.getState().enqueueTurn(THREAD_ID, {
            id: 'queued-next',
            status: 'pending',
            prepared: {
              session,
              inputKind: 'text',
              content: 'Send after the current run',
              mode: 'ask',
              sources: {
                canvasId: 'remote',
                canvasContext: { selectedNodes: [] },
              },
              agentBinding: { kind: 'internal' },
              settings: { modelId: null, reasoningEffort: null },
            },
          }),
        );
        // The old request can finish after the new attachment has claimed the thread.
        await act(async () => finishOld?.({ status: 'aborted' }));
        expect(useChatStore.getState().threadsById[THREAD_ID].queuePaused).toBe(
          false,
        );
        expect(
          useChatStore.getState().threadsById[THREAD_ID].queuedTurns,
        ).toHaveLength(1);
        expect(hasAgentStreamClaim('remote', THREAD_ID)).toBe(true);
        expect(useChatStore.getState().threadsById[THREAD_ID].isStreaming).toBe(
          true,
        );
        apiMocks.remoteSource = {
          status: 'running',
          invocationToken: 'new-run',
        };
        await act(async () =>
          root?.render(
            <Harness session={session} setIsLoading={setIsLoading} />,
          ),
        );
        expect(apiMocks.reconnectStream).toHaveBeenCalledTimes(1);
        // A failure of the current attachment still pauses its own queue.
        await act(async () => finishNew?.({ status: 'aborted' }));
        expect(useChatStore.getState().threadsById[THREAD_ID].queuePaused).toBe(
          true,
        );
      } finally {
        await act(async () => {
          root?.unmount();
          root = undefined;
          finishOld?.({ status: 'aborted' });
          finishNew?.({ status: 'aborted' });
        });
      }
    },
  );

  it.each(['running', 'done'])(
    'does not clear a newer send when a new %s invocation cleans up an already released attachment',
    async (status) => {
      seedStore(false);
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
      apiMocks.remoteSource = { status: 'running', invocationToken: 'run' };
      const setIsLoading = useChatStore.getState().setThreadLoading;
      await renderHarness(session, setIsLoading);
      expect(hasAgentStreamClaim('remote', THREAD_ID)).toBe(false);
      const post = claimAgentStream('remote', THREAD_ID, 'post');
      expect(post).not.toBeNull();
      try {
        await act(async () => setIsLoading(THREAD_ID, true));
        apiMocks.remoteSource = { status, invocationToken: 'new-run' };
        await act(async () =>
          root?.render(
            <Harness session={session} setIsLoading={setIsLoading} />,
          ),
        );
        expect(useChatStore.getState().threadsById[THREAD_ID].isStreaming).toBe(
          true,
        );
        expect(post?.signal.aborted).toBe(false);
      } finally {
        post?.release();
      }
    },
  );

  it.each(['done', 'error'])(
    'clears an attached remote stream and restores missing messages when owner polling reaches %s before SSE completion',
    async (status) => {
      seedStore(false);
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
      apiMocks.remoteSource = { status: 'running', invocationToken: 'run' };
      let finishAttach!: (result: AgentStreamAttachResult) => void;
      apiMocks.reconnectStream.mockImplementationOnce(
        async (_thread, _canvas, callbacks) => {
          callbacks.onEvent({
            type: 'text_delta',
            data: { content: 'Partial' },
          });
          // Model the live event projection, which no longer has historyTurnActive.
          useChatStore.getState().addMessage(THREAD_ID, {
            id: 'live-assistant',
            role: 'assistant',
            segments: [{ kind: 'text', text: 'Partial' }],
          });
          return new Promise((resolve) => {
            finishAttach = resolve;
          });
        },
      );
      const setIsLoading = useChatStore.getState().setThreadLoading;
      await renderHarness(session, setIsLoading);
      expect(useChatStore.getState().threadsById[THREAD_ID].isStreaming).toBe(
        true,
      );
      apiMocks.fetchHistoryPage.mockResolvedValue({
        threadId: THREAD_ID,
        hasMore: false,
        turns: [
          {
            id: 'turn-1',
            messages: [
              { role: 'user', content: 'hi' },
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: 'Completed intermediate reply' }],
              },
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: 'Final answer' }],
              },
            ],
          },
          {
            id: 'turn-2',
            messages: [
              { role: 'user', content: 'Queued follow-up' },
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: 'Follow-up answer' }],
              },
            ],
          },
        ],
      });
      apiMocks.remoteSource = { status, invocationToken: 'run' };
      try {
        await act(async () =>
          root?.render(
            <Harness session={session} setIsLoading={setIsLoading} />,
          ),
        );
        expect(useChatStore.getState().threadsById[THREAD_ID].isStreaming).toBe(
          false,
        );
        expect(latestOwnerHistoryReady).toBe(true);
        expect(apiMocks.fetchHistoryPage).toHaveBeenLastCalledWith(
          THREAD_ID,
          'remote',
          expect.any(Number),
        );
        expect(
          useChatStore
            .getState()
            .threadsById[THREAD_ID].messages.map((message) => ({
              id: message.id,
              role: message.role,
              ...(message.role === 'user' ? { content: message.content } : {}),
              ...(message.role === 'assistant'
                ? { segments: message.segments }
                : {}),
            })),
        ).toEqual([
          { id: 'turn-1:0', role: 'user', content: 'hi' },
          {
            id: 'turn-1:1',
            role: 'assistant',
            segments: [{ kind: 'text', text: 'Completed intermediate reply' }],
          },
          {
            id: 'turn-1:2',
            role: 'assistant',
            segments: [{ kind: 'text', text: 'Final answer' }],
          },
          { id: 'turn-2:0', role: 'user', content: 'Queued follow-up' },
          {
            id: 'turn-2:1',
            role: 'assistant',
            segments: [{ kind: 'text', text: 'Follow-up answer' }],
          },
        ]);
      } finally {
        await act(async () => finishAttach({ status: 'aborted' }));
      }
    },
  );
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
