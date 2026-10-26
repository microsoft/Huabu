// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { ThreadChatInput } from '@/components/Panels/ChatPanel/ThreadChatInput';
import { ChatSessionProvider } from '@/hooks/useChatSession';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadExcludeCanvasSelection,
  selectThreadHistoryLoaded,
  selectThreadMessages,
  useChatStore,
} from '@/store/chatStore';
import { resolveConversationPreparation } from '@/store/conversationPreparation';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';
import { pageLifecycle } from '@/utils/pageLifecycle';

import {
  claimAgentStream,
  hasAgentStreamClaim,
} from './agentStreamCoordinator';
import {
  captureAgentTurnSources,
  dispatchAgentTurn,
  handleStreamEvent,
  observeAgentTurnAcceptance,
  prepareAgentTurn,
  prepareAgentTurnRetry,
  reconcileAgentTurnAfterReconnect,
  resetAgentTurnAcceptanceObserversForTests,
  resumeAgentTurnQueue,
  settleAgentTurnQueue,
  stopAgentTurn,
} from './agentTurnController';
import { useAgentStream, type UseAgentStreamReturn } from './useAgentStream';
import { useChatHistory } from './useChatHistory';

import type { ChatSession } from './useChatSession';
import type { AgentStreamCallbacks } from '@/api/agent';
import type { ChatAttachment } from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  stop: vi.fn(),
  save: vi.fn(),
  validate: vi.fn(),
  draft: vi.fn(),
  history: vi.fn(),
  reconnect: vi.fn(),
}));

vi.mock('react-i18next', async (original) => ({
  ...((await original()) as object),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/Panels/ChatPanel/ContextUsageRing', () => ({
  ContextUsageRing: () => null,
}));
vi.mock('@/components/Panels/ChatPanel/ChatContextSources', () => ({
  ChatContextSources: () => null,
}));
vi.mock('@/components/Panels/ChatPanel/useSlashCommandTypeahead', () => ({
  useSlashCommandTypeahead: () => ({
    slashState: null,
    slashMenuRef: { current: null },
    syncCaret: vi.fn(),
    acceptSlashCommand: vi.fn(),
    handleKeyDown: () => false,
  }),
}));

vi.mock('@/api/agent', () => ({
  agentApi: {
    streamMessage: mocks.stream,
    stopThread: mocks.stop,
    fetchHistoryPage: mocks.history,
    reconnectStream: mocks.reconnect,
  },
}));
vi.mock('@/api/conversationTitles', () => ({
  queryConversationTitles: vi.fn(async () => ({ titles: {} })),
  setConversationTitle: vi.fn(),
}));
vi.mock('@/store/canvasStore', async (original) => ({
  ...((await original()) as object),
  saveCanvasForSubmission: mocks.save,
}));
vi.mock('@/store/conversationOwner', async (original) => ({
  ...((await original()) as object),
  validateConversationView: mocks.validate,
  awaitConversationDraft: mocks.draft,
}));

const session: ChatSession = {
  canvasId: 'canvas-1',
  ownerCanvasId: 'canvas-1',
  threadId: 'thread-1',
  conversationView: null,
};
const questionSession: ChatSession = {
  ...session,
  conversationView: {
    presentationAnchor: { canvasId: 'canvas-1', nodeId: 'question-1' },
    conversationOwner: {
      canvasId: 'canvas-1',
      nodeId: 'question-1',
      threadId: 'thread-1',
    },
  },
};
let root: Root | undefined;
let container: HTMLDivElement | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function request(inputKind: 'text' | 'ink-intent' = 'text', owner = session) {
  return prepareAgentTurn({
    session: owner,
    inputKind,
    content: inputKind === 'text' ? 'Hello' : '',
    mode: 'operate',
    sources: captureAgentTurnSources(owner),
  });
}

describe('queued composer turns', () => {
  let hook: UseAgentStreamReturn;

  beforeEach(async () => {
    function Harness() {
      hook = useAgentStream(session);
      return null;
    }
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness)));
  });

  async function enqueue(content: string) {
    await act(async () => {
      useChatStore.getState().setDraft(session.threadId, content);
      await hook.startStream(content, 'operate', ['review']);
    });
  }

  function finish(
    callbacks: AgentStreamCallbacks,
    threadId = session.threadId,
  ) {
    callbacks.onAccepted?.({
      threadId,
      turnStartSeq: mocks.stream.mock.calls.length * 10,
    });
    callbacks.onEvent({ type: 'done', data: { message: 'Done' } });
    callbacks.onComplete();
  }

  async function waitForQueue() {
    await act(async () => {
      await vi.waitFor(() => {
        expect(
          hasAgentStreamClaim(session.ownerCanvasId, session.threadId),
        ).toBe(false);
        expect(
          useChatStore.getState().threadsById[session.threadId].queuedTurns,
        ).toEqual([]);
      });
    });
  }

  it('drains FIFO after genuine completion even after the composer unmounts', async () => {
    const gate = deferred();
    mocks.stream.mockImplementation(
      async (content, threadId, _mode, callbacks: AgentStreamCallbacks) => {
        if (content === 'First') await gate.promise;
        finish(callbacks, threadId);
      },
    );
    let running!: Promise<void>;
    await act(async () => {
      running = hook.startStream('First', 'operate');
    });
    await enqueue('Second');
    await enqueue('Third');
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().threadsById[session.threadId].draft).toBe(
      '',
    );
    act(() => root?.unmount());
    root = undefined;
    gate.resolve();
    await running;
    await waitForQueue();
    expect(mocks.stream.mock.calls.map(([content]) => content)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });

  it('captures source, settings, slash skills, quotes and attachments once per queued item', async () => {
    act(() => useChatStore.getState().setThreadLoading(session.threadId, true));
    const chat = useChatStore.getState();
    const attachment: ChatAttachment = {
      type: 'image',
      source: 'upload',
      url: '/snapshot.png',
      label: 'Snapshot',
    };
    const excerpt: ChatAttachment = {
      type: 'file',
      source: 'selection',
      content: 'Excerpt',
      label: 'Excerpt',
    };
    const quote = {
      quote: 'Original',
      comment: 'Explain',
      contextBefore: '',
      contextAfter: '',
    };
    act(() => {
      chat.addPendingAttachment(session.threadId, attachment);
      chat.setSelectionAttachment(excerpt);
      chat.addQuotedComment(session.threadId, quote);
      chat.setThreadSettings(session.threadId, {
        modelId: 'captured-model',
        reasoningEffort: null,
      });
    });
    await enqueue('Second');
    act(() =>
      chat.setThreadSettings(session.threadId, {
        modelId: 'new-model',
        reasoningEffort: null,
      }),
    );
    useCanvasStore.getState()._setStateNoAutosave({ nodes: [] });
    await enqueue('Third');
    const [second, third] =
      useChatStore.getState().threadsById[session.threadId].queuedTurns;
    expect(second.prepared).toMatchObject({
      attachments: [attachment, excerpt],
      quotedComments: [quote],
      invokedSkills: ['review'],
      settings: { modelId: 'captured-model' },
      sources: {
        canvasContext: {
          selectedNodes: expect.arrayContaining([
            expect.objectContaining({ id: 'note-1' }),
          ]),
        },
      },
    });
    expect(third.prepared.attachments).toEqual([]);
    expect(third.prepared.quotedComments).toBeUndefined();
    expect(third.prepared.settings.modelId).toBe('new-model');
    expect(useChatStore.getState().selectionAttachment).toBeNull();
  });

  it('does not copy an unaccepted active turn attachment into the next queued message', async () => {
    const gate = deferred();
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        await gate.promise;
        finish(callbacks);
      },
    );
    act(() =>
      useChatStore.getState().addPendingAttachment(session.threadId, {
        type: 'image',
        source: 'upload',
        url: '/first.png',
        label: 'First',
      }),
    );
    let running!: Promise<void>;
    await act(async () => {
      running = hook.startStream('First', 'operate');
    });
    await enqueue('Second');
    expect(
      useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
        .prepared.attachments,
    ).toEqual([]);
    act(() => useChatStore.getState().setQueuePaused(session.threadId, true));
    gate.resolve();
    await act(async () => {
      await running;
    });
  });

  it.each(['error', 'aborted', 'cancelled', 'transport-close'])(
    'pauses instead of advancing on %s',
    async (reason) => {
      const gate = deferred();
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          await gate.promise;
          if (reason !== 'transport-close')
            callbacks.onEvent({
              type: 'done',
              data: { message: '', meta: { stopReason: reason } },
            });
          callbacks.onComplete();
        },
      );
      let running!: Promise<void>;
      await act(async () => {
        running = hook.startStream('First', 'operate');
      });
      await enqueue('Second');
      gate.resolve();
      await act(async () => {
        await running;
      });
      const thread = useChatStore.getState().threadsById[session.threadId];
      expect(thread.queuePaused).toBe(true);
      expect(thread.queuedTurns).toHaveLength(1);
      expect(mocks.stream).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps Stop paused even if completion wins the stop race, and resumes explicitly', async () => {
    const gate = deferred();
    mocks.stop.mockResolvedValueOnce({ stopped: false, acceptance: null });
    mocks.stream.mockImplementation(
      async (content, threadId, _mode, callbacks: AgentStreamCallbacks) => {
        if (content === 'First') await gate.promise;
        finish(callbacks, threadId);
      },
    );
    let running!: Promise<void>;
    await act(async () => {
      running = hook.startStream('First', 'operate');
    });
    await enqueue('Second');
    await act(async () => hook.stopStream());
    gate.resolve();
    await act(async () => {
      await running;
    });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().threadsById[session.threadId].queuePaused,
    ).toBe(true);
    await act(async () => {
      resumeAgentTurnQueue(session);
      resumeAgentTurnQueue(session);
    });
    await waitForQueue();
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  it('retains rejected items, supports removal, and keeps other thread queues independent', async () => {
    act(() => useChatStore.getState().setThreadLoading(session.threadId, true));
    await enqueue('Rejected');
    await enqueue('Removed');
    const other = { ...session, threadId: 'other-thread' };
    const chat = useChatStore.getState();
    chat.enqueueTurn(other.threadId, {
      id: 'other',
      prepared: request('text', other),
      status: 'pending',
    });
    act(() => {
      chat.removeQueuedTurn(
        session.threadId,
        chat.threadsById[session.threadId].queuedTurns[1].id,
      );
      chat.setThreadLoading(session.threadId, false);
    });
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) =>
        callbacks.onError(new ApiError(400, {}, 'Rejected')),
    );
    await act(async () => {
      settleAgentTurnQueue(session, true);
      await vi.waitFor(() =>
        expect(
          useChatStore.getState().threadsById[session.threadId].queuePaused,
        ).toBe(true),
      );
    });
    expect(
      useChatStore.getState().threadsById[session.threadId].queuedTurns,
    ).toMatchObject([{ status: 'pending', prepared: { content: 'Rejected' } }]);
    expect(
      useChatStore.getState().threadsById[other.threadId].queuedTurns,
    ).toHaveLength(1);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'eof'])(
    'blocks ambiguous %s delivery retries until acceptance reconciliation',
    async (closure) => {
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, true),
      );
      await enqueue('Uncertain');
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, false),
      );
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) =>
          closure === 'error'
            ? callbacks.onError(new Error('Disconnected'))
            : callbacks.onComplete(),
      );
      await act(async () => {
        settleAgentTurnQueue(session, true);
        await vi.waitFor(() =>
          expect(
            useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
              .status,
          ).toBe('uncertain'),
        );
        resumeAgentTurnQueue(session);
      });
      expect(mocks.stream).toHaveBeenCalledTimes(1);
      act(() =>
        observeAgentTurnAcceptance(session.ownerCanvasId, {
          threadId: session.threadId,
          turnStartSeq: 5,
        }),
      );
      expect(
        useChatStore.getState().threadsById[session.threadId].queuedTurns,
      ).toEqual([]);
    },
  );

  it('cancels a queued turn locally while its save is pending, even with no server run', async () => {
    const save = deferred();
    act(() => useChatStore.getState().setThreadLoading(session.threadId, true));
    await enqueue('Second');
    act(() =>
      useChatStore.getState().setThreadLoading(session.threadId, false),
    );
    mocks.save.mockReturnValueOnce(save.promise);
    mocks.stop.mockResolvedValueOnce({ stopped: false, acceptance: null });
    await act(async () => {
      resumeAgentTurnQueue(session);
      await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
      stopAgentTurn(session);
      await vi.waitFor(() =>
        expect(
          hasAgentStreamClaim(session.ownerCanvasId, session.threadId),
        ).toBe(false),
      );
    });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(useChatStore.getState().threadsById[session.threadId]).toMatchObject(
      {
        queuePaused: true,
        queuedTurns: [{ status: 'pending' }],
      },
    );
    save.resolve();
    mocks.stream.mockImplementation(async (_content, tid, _mode, callbacks) =>
      finish(callbacks, tid),
    );
    await act(async () => resumeAgentTurnQueue(session));
    await waitForQueue();
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it.each(['draft', 'validate', 'save', 'flush'] as const)(
    'releases external preparation before stalled %s settles',
    async (stage) => {
      const pending = deferred();
      const flush = vi.mocked(useCanvasStore.getState().flushCanvasEvents);
      const operation = stage === 'flush' ? flush : mocks[stage];
      operation.mockReturnValueOnce(pending.promise);
      useChatStore.getState().setAgentBinding(session.threadId, {
        kind: 'external',
        profileId: 'profile-1',
        alias: 'Agent',
      });
      const prepared = request('text', questionSession);
      useChatStore.getState().enqueueTurn(session.threadId, {
        id: 'stalled',
        status: 'pending',
        prepared,
      });
      try {
        await act(async () => {
          resumeAgentTurnQueue(questionSession);
          await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
          stopAgentTurn(questionSession);
          await vi.waitFor(() => {
            expect(
              hasAgentStreamClaim(session.ownerCanvasId, session.threadId),
            ).toBe(false);
            expect(
              resolveConversationPreparation(questionSession).pending,
            ).toBe(false);
            expect(
              useChatStore.getState().threadsById[session.threadId],
            ).toMatchObject({
              queuePaused: true,
              isStreaming: false,
              queuedTurns: [{ id: 'stalled', status: 'pending' }],
            });
          });
        });
        expect(mocks.stream).not.toHaveBeenCalled();
        expect(mocks.stop).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
      }
      await act(async () => {
        await pending.promise;
      });
      expect(mocks.stream).not.toHaveBeenCalled();
    },
  );

  it.each(
    [true, false].flatMap((accepted) =>
      ['eof', 'error'].map((closure) => ({ accepted, closure })),
    ),
  )(
    'reconciles lost acceptance after reconnect (accepted=$accepted, closure=$closure) without advancing the queue',
    async ({ accepted, closure }) => {
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, true),
      );
      await enqueue('Uncertain');
      await enqueue('Later');
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, false),
      );
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) =>
          closure === 'eof'
            ? callbacks.onComplete()
            : callbacks.onError(new Error('Disconnected before acceptance')),
      );
      await act(async () => {
        resumeAgentTurnQueue(session);
        await vi.waitFor(() =>
          expect(
            useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
              .status,
          ).toBe('uncertain'),
        );
      });
      const requestId = mocks.stream.mock.calls[0][4].requestId;
      act(() =>
        useChatStore.getState().setHistoryLoaded(session.threadId, true),
      );
      if (closure === 'error') {
        expect(
          selectThreadMessages(useChatStore.getState(), session.threadId).at(
            -1,
          ),
        ).toMatchObject({ role: 'status', status: 'error' });
      }
      mocks.stop.mockResolvedValueOnce({
        stopped: false,
        acceptance: null,
        request: { id: requestId, accepted },
      });
      mocks.reconnect.mockImplementationOnce(
        async (_thread, _canvas, callbacks: AgentStreamCallbacks) => {
          callbacks.onEvent({ type: 'done', data: { message: 'Answer' } });
          callbacks.onComplete();
          return { status: 'completed' };
        },
      );
      function ReconnectHarness() {
        useChatHistory(session, useChatStore.getState().setThreadLoading);
        return null;
      }
      await act(async () => {
        root?.render(createElement(ReconnectHarness));
      });
      await vi.waitFor(() =>
        expect(
          hasAgentStreamClaim(session.ownerCanvasId, session.threadId),
        ).toBe(false),
      );
      expect(mocks.reconnect).toHaveBeenCalledOnce();
      expect(mocks.stop).toHaveBeenCalledWith(
        session.threadId,
        session.ownerCanvasId,
        requestId,
      );
      expect(
        useChatStore.getState().threadsById[session.threadId],
      ).toMatchObject({
        queuePaused: true,
        queuedTurns: accepted
          ? [{ status: 'pending', prepared: { content: 'Later' } }]
          : [
              { status: 'pending', prepared: { content: 'Uncertain' } },
              { status: 'pending' },
            ],
      });
      expect(mocks.stream).toHaveBeenCalledOnce();
      await reconcileAgentTurnAfterReconnect(
        session.ownerCanvasId,
        session.threadId,
      );
      expect(mocks.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(['draft', 'validate', 'save', 'flush'] as const)(
    'exposes Stop and queue actions in the actual composer during direct %s preparation',
    async (stage) => {
      const pending = deferred();
      const operation =
        stage === 'flush'
          ? vi.mocked(useCanvasStore.getState().flushCanvasEvents)
          : mocks[stage];
      operation.mockReturnValueOnce(pending.promise);
      let sending: Promise<void> | undefined;
      if (container) document.body.appendChild(container);
      function Composer() {
        const stream = useAgentStream(questionSession);
        return createElement(ChatSessionProvider, {
          value: questionSession,
          children: createElement(ThreadChatInput, {
            mode: 'operate',
            isStreaming: stream.isLoading,
            onStop: stream.stopStream,
            onSubmit: (event, mode, draft) => {
              event.preventDefault();
              sending = stream.startStream(draft, mode);
            },
          }),
        });
      }
      await act(async () => {
        useChatStore.getState().setDraft(session.threadId, 'Direct request');
        root?.render(createElement(Composer));
      });
      try {
        await act(async () => {
          const send = container?.querySelector<HTMLButtonElement>(
            '[aria-label="chat.send"]',
          );
          expect(send?.disabled).toBe(false);
          send?.click();
          await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
        });
        expect(mocks.stream).not.toHaveBeenCalled();
        expect(
          container?.querySelector('[aria-label="chat.addToQueue"]'),
        ).not.toBeNull();
        const stop = container?.querySelector<HTMLButtonElement>(
          '[aria-label="chat.stop"]',
        );
        expect(stop).not.toBeNull();
        expect(stop?.disabled).toBe(false);
        await act(async () => {
          stop?.click();
          await sending;
        });
        expect(
          hasAgentStreamClaim(session.ownerCanvasId, session.threadId),
        ).toBe(false);
        expect(container?.querySelector('[aria-label="chat.stop"]')).toBeNull();
        expect(
          container?.querySelector('[aria-label="chat.send"]'),
        ).not.toBeNull();
        expect(mocks.stream).not.toHaveBeenCalled();
        expect(mocks.stop).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
        await act(async () => {
          await sending;
        });
      }
    },
  );

  it.each(
    [true, false].flatMap((accepted) =>
      [true, false].map((anchored) => ({ accepted, anchored })),
    ),
  )(
    'reconciles a cached direct-send error without a running owner (accepted=$accepted, anchored=$anchored)',
    async ({ accepted, anchored }) => {
      const owner = anchored ? questionSession : session;
      if (anchored) {
        useCanvasStore.getState()._setStateNoAutosave({
          nodes: [
            {
              id: 'question-1',
              type: 'question',
              position: { x: 0, y: 0 },
              data: { threadId: session.threadId, status: 'idle' },
            },
          ],
        });
        vi.spyOn(
          useAcpThreadChangesStore.getState(),
          'load',
        ).mockResolvedValue();
      }
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) =>
          callbacks.onError(new Error('Disconnected before acceptance')),
      );
      const onAccepted = vi.fn();
      const onAcceptanceRejected = vi.fn();
      await dispatchAgentTurn(request('text', owner), {
        onAccepted,
        onAcceptanceRejected,
      });
      useChatStore.getState().setHistoryLoaded(session.threadId, true);
      expect(
        selectThreadMessages(useChatStore.getState(), session.threadId).at(-1),
      ).toMatchObject({ role: 'status', status: 'error' });
      const requestId = mocks.stream.mock.calls[0][4].requestId;
      mocks.stop.mockResolvedValueOnce({
        stopped: false,
        acceptance: null,
        request: { id: requestId, accepted },
      });
      function Reopen() {
        useChatHistory(owner, useChatStore.getState().setThreadLoading);
        return null;
      }
      await act(async () => root?.render(createElement(Reopen)));
      expect(mocks.reconnect).toHaveBeenCalledOnce();
      expect(mocks.stop).toHaveBeenCalledWith(
        session.threadId,
        session.ownerCanvasId,
        requestId,
      );
      expect(onAccepted).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(onAcceptanceRejected).toHaveBeenCalledTimes(accepted ? 0 : 1);
      expect(hasAgentStreamClaim(session.ownerCanvasId, session.threadId)).toBe(
        false,
      );
      expect(mocks.stream).toHaveBeenCalledOnce();
    },
  );

  it.each(['offline', 'mismatched'] as const)(
    'retains uncertain delivery when reconnect reconciliation is %s',
    async (failure) => {
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, true),
      );
      await enqueue('Uncertain');
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, false),
      );
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) =>
          callbacks.onComplete(),
      );
      await act(async () => {
        resumeAgentTurnQueue(session);
        await vi.waitFor(() =>
          expect(
            useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
              .status,
          ).toBe('uncertain'),
        );
      });
      if (failure === 'offline')
        mocks.stop.mockRejectedValueOnce(new Error('offline'));
      else
        mocks.stop.mockResolvedValueOnce({
          stopped: false,
          acceptance: null,
          request: { id: 'another-request', accepted: true },
        });
      await expect(
        reconcileAgentTurnAfterReconnect(
          session.ownerCanvasId,
          session.threadId,
        ),
      ).rejects.toThrow();
      await act(async () => resumeAgentTurnQueue(session));
      expect(
        useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
          .status,
      ).toBe('uncertain');
      expect(mocks.stream).toHaveBeenCalledOnce();
    },
  );

  it.each(['save', 'transport'])(
    'routes transcript Retry through the original queue item after %s rejection',
    async (failure) => {
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, true),
      );
      await enqueue('Retry once');
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, false),
      );
      if (failure === 'save')
        mocks.save.mockRejectedValueOnce(new Error('Save failed'));
      else
        mocks.stream.mockImplementationOnce(
          async (_content, _tid, _mode, callbacks) =>
            callbacks.onError(new ApiError(400, {}, 'Rejected')),
        );
      await act(async () => {
        resumeAgentTurnQueue(session);
        await vi.waitFor(() =>
          expect(
            useChatStore.getState().threadsById[session.threadId].queuePaused,
          ).toBe(true),
        );
      });
      const message = selectThreadMessages(
        useChatStore.getState(),
        session.threadId,
      ).find((m) => m.role === 'user');
      if (!message || message.role !== 'user')
        throw new Error('Missing retry message');
      expect(message.queuedTurnId).toBeDefined();
      mocks.stream.mockImplementation(async (_content, tid, _mode, callbacks) =>
        finish(callbacks, tid),
      );
      await act(async () => hook.retryStream(message, 'operate'));
      await waitForQueue();
      await act(async () => resumeAgentTurnQueue(session));
      expect(mocks.stream).toHaveBeenCalledTimes(failure === 'save' ? 1 : 2);
    },
  );

  it.each([true, false])(
    'reconciles uncertain delivery against persisted acceptance=%s when no run is active',
    async (accepted) => {
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, true),
      );
      await enqueue('Unknown');
      act(() =>
        useChatStore.getState().setThreadLoading(session.threadId, false),
      );
      mocks.stream.mockImplementationOnce(
        async (_content, _tid, _mode, callbacks) =>
          callbacks.onError(new Error('Connection lost')),
      );
      await act(async () => {
        resumeAgentTurnQueue(session);
        await vi.waitFor(() =>
          expect(
            useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
              .status,
          ).toBe('uncertain'),
        );
      });
      const requestId = mocks.stream.mock.calls[0][4].requestId;
      mocks.stop.mockResolvedValueOnce({
        stopped: false,
        acceptance: null,
        request: { id: requestId, accepted },
      });
      await act(async () => {
        stopAgentTurn(session);
        await vi.waitFor(() => {
          const turns =
            useChatStore.getState().threadsById[session.threadId].queuedTurns;
          if (accepted) expect(turns).toEqual([]);
          else expect(turns[0].status).toBe('pending');
        });
      });
      expect(mocks.stop).toHaveBeenCalledWith(
        session.threadId,
        session.ownerCanvasId,
        requestId,
      );
      expect(
        useChatStore.getState().threadsById[session.threadId].queuePaused,
      ).toBe(true);
      expect(mocks.stream).toHaveBeenCalledOnce();
      mocks.stream.mockImplementation(async (_content, tid, _mode, callbacks) =>
        finish(callbacks, tid),
      );
      await act(async () => resumeAgentTurnQueue(session));
      await waitForQueue();
      expect(mocks.stream).toHaveBeenCalledTimes(accepted ? 1 : 2);
      if (!accepted)
        expect(mocks.stream.mock.calls[1][4].requestId).not.toBe(requestId);
    },
  );

  it('reloads history after inactive accepted Stop without remounting the composer', async () => {
    const historyGate = deferred();
    act(() => useChatStore.getState().setHistoryLoaded(session.threadId, true));
    function MountedChat() {
      hook = useAgentStream(session);
      useChatHistory(session, useChatStore.getState().setThreadLoading);
      const historyLoaded = useChatStore((state) =>
        selectThreadHistoryLoaded(state, session.threadId),
      );
      return createElement(ChatSessionProvider, {
        value: session,
        children: createElement(ThreadChatInput, {
          mode: 'operate',
          isStreaming: hook.isLoading,
          submitDisabled: !historyLoaded,
          onStop: hook.stopStream,
          onSubmit: (event, mode, draft) => {
            event.preventDefault();
            void hook.startStream(draft, mode);
          },
        }),
      });
    }
    if (container) document.body.appendChild(container);
    await act(async () => root?.render(createElement(MountedChat)));
    expect(mocks.history).not.toHaveBeenCalled();
    act(() => useChatStore.getState().setThreadLoading(session.threadId, true));
    await enqueue('Unknown');
    await enqueue('Later');
    act(() =>
      useChatStore.getState().setThreadLoading(session.threadId, false),
    );
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) =>
        callbacks.onError(new Error('Connection lost before acceptance')),
    );
    await act(async () => {
      resumeAgentTurnQueue(session);
      await vi.waitFor(() =>
        expect(
          useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
            .status,
        ).toBe('uncertain'),
      );
    });
    const requestId = mocks.stream.mock.calls[0][4].requestId;
    mocks.stop.mockResolvedValueOnce({
      stopped: false,
      acceptance: null,
      request: { id: requestId, accepted: true },
    });
    mocks.history.mockImplementationOnce(async () => {
      await historyGate.promise;
      return {
        threadId: session.threadId,
        turns: [
          {
            id: 'finished-turn',
            messages: [
              { role: 'user', content: 'Unknown' },
              {
                role: 'assistant',
                parts: [{ kind: 'text', text: 'Persisted answer' }],
              },
            ],
          },
        ],
        hasMore: false,
      };
    });
    act(() =>
      useChatStore.getState().setDraft(session.threadId, 'Unsent draft'),
    );
    try {
      await act(async () => {
        container
          ?.querySelector<HTMLButtonElement>('[aria-label="chat.stop"]')
          ?.click();
      });
      expect(mocks.stop).toHaveBeenCalledWith(
        session.threadId,
        session.ownerCanvasId,
        requestId,
      );
      expect(mocks.history).toHaveBeenCalledOnce();
      expect(
        container?.querySelector<HTMLButtonElement>(
          '[aria-label="chat.addToQueue"]',
        )?.disabled,
      ).toBe(true);
      await act(async () => {
        historyGate.resolve();
        await historyGate.promise;
      });
      expect(
        useChatStore.getState().threadsById[session.threadId],
      ).toMatchObject({
        historyLoaded: true,
        draft: 'Unsent draft',
        queuePaused: true,
        queuedTurns: [{ status: 'pending', prepared: { content: 'Later' } }],
        messages: [
          { role: 'user', content: 'Unknown' },
          {
            role: 'assistant',
            segments: [{ kind: 'text', text: 'Persisted answer' }],
          },
        ],
      });
      expect(
        container?.querySelector<HTMLButtonElement>(
          '[aria-label="chat.addToQueue"]',
        )?.disabled,
      ).toBe(false);
      const resume = [...(container?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent === 'chat.resumeQueue',
      );
      expect(resume?.disabled).toBe(false);
      expect(mocks.stream).toHaveBeenCalledOnce();
      expect(mocks.history).toHaveBeenCalledOnce();
      expect(mocks.reconnect).not.toHaveBeenCalled();
    } finally {
      historyGate.resolve();
    }
  });

  it('keeps an uncertain item blocked when Stop reconciliation fails', async () => {
    act(() => useChatStore.getState().setThreadLoading(session.threadId, true));
    await enqueue('Unknown');
    act(() =>
      useChatStore.getState().setThreadLoading(session.threadId, false),
    );
    mocks.stream.mockImplementationOnce(
      async (_content, _tid, _mode, callbacks) =>
        callbacks.onError(new Error('Connection lost')),
    );
    await act(async () => {
      resumeAgentTurnQueue(session);
      await vi.waitFor(() =>
        expect(
          useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
            .status,
        ).toBe('uncertain'),
      );
    });
    mocks.stop.mockRejectedValueOnce(new Error('Still offline'));
    await act(async () => stopAgentTurn(session));
    expect(
      useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
        .status,
    ).toBe('uncertain');
    expect(mocks.stream).toHaveBeenCalledOnce();
  });

  it('does not overwrite rejection reconciliation when the failed transport finishes later', async () => {
    act(() => useChatStore.getState().setThreadLoading(session.threadId, true));
    await enqueue('Unknown');
    act(() =>
      useChatStore.getState().setThreadLoading(session.threadId, false),
    );
    const gate = deferred();
    mocks.stream.mockImplementationOnce(
      async (_content, _tid, _mode, callbacks) => {
        callbacks.onError(new Error('Connection lost'));
        await gate.promise;
      },
    );
    mocks.stop.mockImplementationOnce(async (_tid, _canvasId, requestId) => ({
      stopped: false,
      acceptance: null,
      request: { id: requestId, accepted: false },
    }));
    await act(async () => {
      resumeAgentTurnQueue(session);
      await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledOnce());
      stopAgentTurn(session);
      await vi.waitFor(() =>
        expect(
          useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
            .status,
        ).toBe('pending'),
      );
      gate.resolve();
      await vi.waitFor(() =>
        expect(
          hasAgentStreamClaim(session.ownerCanvasId, session.threadId),
        ).toBe(false),
      );
    });
    expect(
      useChatStore.getState().threadsById[session.threadId].queuedTurns[0]
        .status,
    ).toBe('pending');
  });

  it('pins queued threads in memory without persisting queued submissions', async () => {
    act(() => useChatStore.getState().setThreadLoading(session.threadId, true));
    await enqueue('Keep this queued');
    act(() => {
      const chat = useChatStore.getState();
      chat.setThreadLoading(session.threadId, false);
      chat.evictInactiveThreads(0);
    });
    expect(
      useChatStore.getState().threadsById[session.threadId].queuedTurns,
    ).toHaveLength(1);
    expect(
      useChatStore.persist.getOptions().partialize?.(useChatStore.getState()),
    ).not.toHaveProperty('threadsById');
  });

  it.each([
    { external: false, anchored: false },
    { external: true, anchored: false },
    { external: false, anchored: true },
    { external: true, anchored: true },
  ])(
    'dispatches queued turns through the shared owner/binding pipeline: %j',
    async ({ external, anchored }) => {
      const owner = anchored ? questionSession : session;
      const binding = external
        ? { kind: 'external' as const, profileId: 'profile-1', alias: 'Agent' }
        : { kind: 'internal' as const };
      vi.spyOn(useAcpThreadChangesStore.getState(), 'load').mockResolvedValue();
      act(() => {
        const chat = useChatStore.getState();
        chat.setAgentBinding(owner.threadId, binding);
        chat.enqueueTurn(owner.threadId, {
          id: 'queued-owner',
          prepared: request('text', owner),
          status: 'pending',
        });
      });
      mocks.stream.mockImplementation(
        async (_content, threadId, _mode, callbacks: AgentStreamCallbacks) =>
          finish(callbacks, threadId),
      );
      await act(async () => resumeAgentTurnQueue(owner));
      await waitForQueue();
      expect(mocks.stream).toHaveBeenCalledOnce();
      expect(mocks.stream.mock.calls[0][4]).toMatchObject({
        agentBinding: binding,
        anchorNodeId: anchored ? 'question-1' : undefined,
      });
    },
  );

  it('restores captured attachments on definitive rejection without discarding newly staged ones', async () => {
    const first: ChatAttachment = {
      type: 'image',
      source: 'upload',
      url: '/first.png',
      label: 'First',
    };
    const later: ChatAttachment = {
      type: 'image',
      source: 'upload',
      url: '/later.png',
      label: 'Later',
    };
    act(() => {
      useChatStore.getState().setDraft(session.threadId, 'First');
      useChatStore.getState().addPendingAttachment(session.threadId, first);
    });
    mocks.save.mockImplementationOnce(async () => {
      useChatStore.getState().addPendingAttachment(session.threadId, later);
      throw new Error('Save failed');
    });
    await act(async () => hook.startStream('First', 'operate'));
    expect(useChatStore.getState().threadsById[session.threadId]).toMatchObject(
      {
        draft: 'First',
        pendingAttachments: [later, first],
      },
    );
  });
});

it('tracks local submission only until durable acceptance, not the Agent stream', async () => {
  const release = deferred();
  let callbacks!: AgentStreamCallbacks;
  mocks.stream.mockImplementationOnce(
    async (_content, _thread, _mode, handlers: AgentStreamCallbacks) => {
      callbacks = handlers;
      await release.promise;
      handlers.onComplete();
    },
  );
  const tracker = vi.spyOn(pageLifecycle, 'run');
  let streamingDone = false;
  const turn = dispatchAgentTurn(request()).then(() => {
    streamingDone = true;
  });
  try {
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    const tracked = tracker.mock.results.at(-1)?.value as Promise<void>;
    let localDone = false;
    void tracked.then(() => {
      localDone = true;
    });
    await Promise.resolve();
    expect(localDone).toBe(false);
    callbacks.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 7 });
    await tracked;
    expect(localDone).toBe(true);
    expect(streamingDone).toBe(false);
    expect(mocks.stop).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await turn;
    tracker.mockRestore();
  }
});

it('records genuine completion by owner thread, not tool updates or repeated done events', () => {
  const ctx = { threadId: 'completed-owner', assistantId: 'assistant-1' };
  handleStreamEvent({ type: 'text_delta', data: { content: 'Answer' } }, ctx);
  handleStreamEvent(
    {
      type: 'tool_call_update',
      data: { toolCallId: 'tool-1', status: 'completed' },
    },
    ctx,
  );
  expect(
    useChatStore.getState().threadsById[ctx.threadId]?.completedTurnId,
  ).toBeUndefined();
  handleStreamEvent({ type: 'done', data: { message: 'Answer' } }, ctx);
  expect(
    useChatStore.getState().threadsById[ctx.threadId]?.completedTurnId,
  ).toBe('assistant-1');
  expect(
    useChatStore.getState().threadsById['other-thread']?.completedTurnId,
  ).toBeUndefined();
  const snapshot = useChatStore.getState();
  handleStreamEvent({ type: 'done', data: { message: 'Answer' } }, ctx);
  expect(useChatStore.getState()).toBe(snapshot);
});

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentTurnAcceptanceObserversForTests();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset().mockResolvedValue({
    stopped: true,
    acceptance: null,
  });
  mocks.validate.mockReset().mockResolvedValue(undefined);
  mocks.draft.mockReset().mockResolvedValue(undefined);
  mocks.history.mockReset().mockResolvedValue({
    threadId: session.threadId,
    turns: [
      { id: 'turn-1', messages: [{ role: 'user', content: 'Uncertain' }] },
    ],
    hasMore: false,
  });
  mocks.reconnect.mockReset().mockResolvedValue({ status: 'inactive' });
  mocks.stream
    .mockReset()
    .mockImplementation(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        callbacks.onAccepted?.({
          threadId: 'thread-1',
          turnStartSeq: 5 + (mocks.stream.mock.calls.length - 1) * 10,
        });
        callbacks.onEvent({ type: 'text_delta', data: { content: 'Answer' } });
        callbacks.onComplete();
      },
    );
  useChatStore.setState({
    threadsById: {},
    bindingByThread: {},
    settingsByThread: {},
    lastActionByThread: {},
    ephemeralMetadataThreads: {},
    ephemeralSettingsThreads: {},
    selectionAttachment: null,
  });
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-1',
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    nodes: [
      {
        id: 'note-1',
        type: 'note',
        selected: true,
        position: { x: 0, y: 0 },
        data: { content: 'Source' },
      },
      { id: 'sketch-1', type: 'sketch', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [],
  });
  useGesturePreviewStore.setState({
    sketchStrokeSelection: { 'sketch-1': ['stroke-1'] },
  });
  vi.spyOn(useCanvasStore.getState(), 'flushCanvasEvents').mockResolvedValue();
  vi.spyOn(useCanvasStore.getState(), 'updateNodeData').mockImplementation(
    () => {},
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('Ink interpretation lifecycle', () => {
  const ctx = {
    threadId: 'thread-1',
    assistantId: 'assistant-1',
    userMessageId: 'ink-user',
  };
  const startReport = (
    id: string,
    rawInput: unknown,
    internalToolName: string | undefined = 'report_ink_intent',
  ) =>
    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: id,
          title: 'report_ink_intent',
          internalToolName,
          status: 'pending',
          rawInput,
        },
      },
      ctx,
    );
  const updateReport = (
    id: string,
    data: {
      status?: 'pending' | 'in_progress' | 'completed' | 'failed';
      rawOutput?: unknown;
    },
  ) =>
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: { toolCallId: id, ...data },
      },
      ctx,
    );
  const interpretation = () => {
    const message = selectThreadMessages(
      useChatStore.getState(),
      ctx.threadId,
    ).find((message) => message.id === ctx.userMessageId);
    return message?.role === 'user' ? message.inkInterpretation : undefined;
  };
  beforeEach(() => {
    useChatStore.getState().addMessage(ctx.threadId, {
      id: ctx.userMessageId,
      role: 'user',
      content: '',
      inputKind: 'ink-intent',
      inkInterpretation: { state: 'pending' },
      selectedNodeIds: ['sketch-1'],
      selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
    });
  });

  it('retains report output without confirming it before terminal status', () => {
    startReport('report-1', { text: '  Explain this arrow  ' });
    updateReport('report-1', {
      status: 'in_progress',
      rawOutput: {
        text: '  Explain this arrow  ',
        explanation: '  It connects the two notes.  ',
      },
    });
    expect(interpretation()).toEqual({ state: 'pending' });
    updateReport('report-1', { status: 'completed' });
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'Explain this arrow',
      explanation: 'It connects the two notes.',
    });
    updateReport('report-1', { rawOutput: '{}' });
    expect(selectThreadMessages(useChatStore.getState(), ctx.threadId)).toEqual(
      [expect.objectContaining({ content: '', selectedNodeIds: ['sketch-1'] })],
    );
  });

  it.each([
    ['failed', { status: 'failed' as const }],
    [
      'error envelope',
      {
        status: 'completed' as const,
        rawOutput: {
          tool: 'report_ink_intent',
          status: 'error',
          error: 'Rejected',
        },
      },
    ],
    [
      'malformed result',
      { status: 'completed' as const, rawOutput: 'not JSON' },
    ],
  ])(
    'does not confirm a %s report; a successful retry wins once',
    (_label, terminal) => {
      startReport('report-1', { text: 'Rejected summary' });
      updateReport('report-1', terminal);
      expect(interpretation()).toEqual({ state: 'failed' });
      startReport('report-2', {
        text: 'Accepted summary',
        explanation: 'Verified in context.',
      });
      updateReport('report-2', { status: 'completed' });
      startReport('report-3', { text: 'Later summary' });
      updateReport('report-3', { status: 'completed' });
      updateReport('report-2', { status: 'failed' });
      expect(interpretation()).toEqual({
        state: 'reported',
        text: 'Accepted summary',
        explanation: 'Verified in context.',
      });
    },
  );

  it('keeps reports in the captured user message and owner thread', () => {
    startReport('report-1', { text: 'First Ink request' });
    for (const threadId of ['thread-1', 'thread-2']) {
      useChatStore.getState().addMessage(threadId, {
        id: 'new-user',
        role: 'user',
        content: '',
        inputKind: 'ink-intent',
        inkInterpretation: { state: 'pending' },
      });
    }
    updateReport('report-1', { status: 'completed' });
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'First Ink request',
    });
    for (const threadId of ['thread-1', 'thread-2']) {
      expect(
        selectThreadMessages(useChatStore.getState(), threadId).find(
          (message) => message.id === 'new-user',
        ),
      ).toMatchObject({
        inkInterpretation: { state: 'pending' },
      });
    }
  });

  it('retains the original owner when missing args are followed by output after a newer user message', () => {
    const streamContext = {
      threadId: ctx.threadId,
      assistantId: ctx.assistantId,
    };
    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: 'delayed-report',
          title: 'report_ink_intent',
          internalToolName: 'report_ink_intent',
          status: 'pending',
        },
      },
      streamContext,
    );
    useChatStore.getState().addMessage(ctx.threadId, {
      id: 'newer-ink-user',
      role: 'user',
      content: '',
      inputKind: 'ink-intent',
      inkInterpretation: { state: 'pending' },
    });
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: {
          toolCallId: 'delayed-report',
          status: 'in_progress',
          rawOutput: { text: 'Original request interpretation' },
        },
      },
      streamContext,
    );
    expect(interpretation()).toEqual({ state: 'pending' });
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: { toolCallId: 'delayed-report', status: 'completed' },
      },
      streamContext,
    );
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'Original request interpretation',
    });
    expect(
      selectThreadMessages(useChatStore.getState(), ctx.threadId).at(-1),
    ).toMatchObject({
      id: 'newer-ink-user',
      inkInterpretation: { state: 'pending' },
    });
  });

  it('ignores a generic external tool with the same title', () => {
    startReport('external-report', { text: 'Not host owned' }, '');
    updateReport('external-report', { status: 'completed' });
    expect(interpretation()).toEqual({ state: 'pending' });
  });

  it('does not attach a text turn report to the preceding Ink request', () => {
    useChatStore.getState().addMessage(ctx.threadId, {
      id: 'text-user',
      role: 'user',
      content: 'Ordinary text',
    });
    const textCtx = { threadId: ctx.threadId, assistantId: 'text-assistant' };
    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: 'text-report',
          title: 'report_ink_intent',
          internalToolName: 'report_ink_intent',
          rawInput: { text: 'Wrong owner' },
        },
      },
      textCtx,
    );
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: { toolCallId: 'text-report', status: 'completed' },
      },
      textCtx,
    );
    handleStreamEvent({ type: 'done', data: { message: '' } }, textCtx);
    expect(interpretation()).toEqual({ state: 'pending' });
    expect(
      selectThreadMessages(useChatStore.getState(), ctx.threadId)[1],
    ).not.toHaveProperty('inkInterpretation');
  });

  it.each([
    [undefined, 'missing'],
    ['aborted', 'interrupted'],
    ['cancelled', 'interrupted'],
    ['error', 'failed'],
  ])('settles a no-report turn ending with %s as %s', (stopReason, state) => {
    handleStreamEvent(
      {
        type: 'done',
        data: { message: '', meta: { stopReason } },
      },
      ctx,
    );
    expect(interpretation()).toEqual({ state });
  });

  it.each([
    [
      { status: 'inferred', text: 'Old summary' },
      { state: 'reported', text: 'Old summary' },
    ],
    [{ status: 'clarify', text: 'Old question' }, { state: 'legacy' }],
    [{ status: 'unsupported', text: 'Old limitation' }, { state: 'legacy' }],
    [{ text: 'Invalid\nsummary' }, { state: 'failed' }],
  ])(
    'normalizes historical and malformed report payloads %j',
    (rawInput, expected) => {
      startReport('report-1', rawInput);
      updateReport('report-1', { status: 'completed' });
      handleStreamEvent({ type: 'done', data: { message: '' } }, ctx);
      expect(interpretation()).toEqual(expected);
    },
  );

  it.each([
    {
      text: '  Canonical summary  ',
      explanation: '  Confirmed context.  ',
      renamed: true,
    },
    {
      tool: 'report_ink_intent',
      status: 'success',
      data: {
        text: '  Canonical summary  ',
        explanation: '  Confirmed context.  ',
        renamed: true,
      },
    },
  ])('prefers canonical confirmed output over report input %j', (rawOutput) => {
    startReport('canonical-report', {
      text: 'Draft summary',
      explanation: 'Draft explanation.',
    });
    updateReport('canonical-report', { rawOutput });
    expect(interpretation()).toEqual({ state: 'pending' });
    updateReport('canonical-report', { status: 'completed' });
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'Canonical summary',
      explanation: 'Confirmed context.',
    });
  });

  it('retains the first successful legacy record through subsequent reports', () => {
    startReport('legacy-report', {
      status: 'clarify',
      text: 'An old question',
    });
    updateReport('legacy-report', { status: 'completed' });
    startReport('new-report', { text: 'New interpretation' });
    updateReport('new-report', { status: 'completed' });
    updateReport('new-report', { status: 'failed' });
    expect(interpretation()).toEqual({ state: 'legacy' });
  });

  it('allows a successful report to supersede a missing-report fallback', () => {
    handleStreamEvent({ type: 'done', data: { message: '' } }, ctx);
    expect(interpretation()).toEqual({ state: 'missing' });
    startReport('late-report', { text: 'Confirmed interpretation' });
    updateReport('late-report', { status: 'completed' });
    expect(interpretation()).toEqual({
      state: 'reported',
      text: 'Confirmed interpretation',
    });
  });

  it('initializes optimistic Ink as pending and settles no-report completion', async () => {
    mocks.stream.mockImplementationOnce(
      async (_a, _b, _c, callbacks: AgentStreamCallbacks) => {
        expect(
          selectThreadMessages(useChatStore.getState(), ctx.threadId).at(-1),
        ).toMatchObject({
          role: 'user',
          content: '',
          inkInterpretation: { state: 'pending' },
        });
        callbacks.onAccepted?.({ threadId: ctx.threadId, turnStartSeq: 5 });
        callbacks.onComplete();
      },
    );
    await dispatchAgentTurn(request('ink-intent'));
    expect(
      selectThreadMessages(useChatStore.getState(), ctx.threadId).at(-1),
    ).toMatchObject({ inkInterpretation: { state: 'missing' } });
  });

  it('settles optimistic Ink after stream rejection', async () => {
    mocks.stream.mockRejectedValueOnce(new Error('Offline'));
    await dispatchAgentTurn(request('ink-intent'));
    expect(
      selectThreadMessages(useChatStore.getState(), ctx.threadId)
        .filter((message) => message.role === 'user')
        .at(-1),
    ).toMatchObject({ inkInterpretation: { state: 'failed' } });
  });

  it('settles Ink only after stop is confirmed', async () => {
    const gate = deferred();
    mocks.stop.mockImplementationOnce(async () => {
      await gate.promise;
      return { stopped: true, acceptance: null };
    });
    stopAgentTurn(session);
    expect(interpretation()).toEqual({ state: 'pending' });
    gate.resolve();
    await vi.waitFor(() =>
      expect(interpretation()).toEqual({ state: 'interrupted' }),
    );
  });
});

describe('shared Agent turn input', () => {
  it('freezes Sigil targets through asynchronous saving and keeps them distinct from Canvas selection', async () => {
    const gate = deferred();
    mocks.save.mockReturnValueOnce(gate.promise);
    const prepared = request('ink-intent');
    prepared.inkResources = [
      {
        id: 'sigil',
        fingerprint: '0123456789abcdef',
        targetNodeId: 'paper',
        targetType: 'pdf',
        label: 'Original paper',
        sourceBounds: { x: 0, y: 0, width: 40, height: 40 },
        sources: [1, 2, 3, 4].map((i) => ({
          nodeId: 'sketch-1',
          strokeId: `stroke-${i}`,
        })),
      },
    ];
    const running = dispatchAgentTurn(prepared);
    prepared.inkResources[0].targetNodeId = 'replacement';
    gate.resolve();
    expect((await running).status).toBe('completed');
    expect(mocks.stream.mock.calls[0][4].inkResources[0].targetNodeId).toBe(
      'paper',
    );
    const message = selectThreadMessages(
      useChatStore.getState(),
      session.threadId,
    )[0];
    expect(message).toMatchObject({
      inkResources: [expect.objectContaining({ targetNodeId: 'paper' })],
      attachments: [
        expect.objectContaining({
          originNodeId: 'paper',
          label: 'Original paper',
        }),
      ],
    });
    if (message.role !== 'user') throw new Error('Expected user input');
    expect(message.selectedNodeIds).not.toContain('paper');
    const retry = prepareAgentTurnRetry(session, message, 'operate');
    expect(retry.inkResources?.[0].targetNodeId).toBe('paper');
    expect(retry.attachments).toEqual([]);
  });
  it('deduplicates Frame-nested Ink while excluding its Question anchor', () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'frame-1',
          type: 'frame',
          selected: true,
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'question-1',
          type: 'question',
          parentId: 'frame-1',
          position: { x: 10, y: 10 },
          data: { threadId: 'thread-1' },
        },
        {
          id: 'sketch-1',
          type: 'sketch',
          parentId: 'frame-1',
          position: { x: 20, y: 20 },
          data: {},
        },
      ],
    });

    const sources = captureAgentTurnSources(questionSession, {
      nodeIds: ['frame-1'],
      strokeSelection: { 'sketch-1': ['stroke-1'] },
    });

    expect(sources.canvasContext.selectedNodes).toEqual([
      {
        id: 'frame-1',
        type: 'frame',
        children: [
          {
            id: 'sketch-1',
            type: 'sketch',
            strokeIds: ['stroke-1'],
          },
        ],
      },
    ]);
  });

  it('projects an Agent interpretation without rendering its tool call', () => {
    useChatStore.getState().addMessage('thread-1', {
      id: 'ink-user',
      role: 'user',
      content: '',
      inputKind: 'ink-intent',
    });

    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: 'intent-1',
          title: 'report_ink_intent',
          status: 'pending',
          rawInput: {
            text: 'Expand the third comparison step',
            explanation: 'The arrow points to the third step.',
          },
          internalToolName: 'report_ink_intent',
        },
      },
      { threadId: 'thread-1', assistantId: 'assistant-1' },
    );
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: {
          toolCallId: 'intent-1',
          status: 'completed',
          rawOutput: '{}',
        },
      },
      { threadId: 'thread-1', assistantId: 'assistant-1' },
    );

    expect(selectThreadMessages(useChatStore.getState(), 'thread-1')).toEqual([
      expect.objectContaining({
        id: 'ink-user',
        inkInterpretation: {
          state: 'reported',
          text: 'Expand the third comparison step',
          explanation: 'The arrow points to the third step.',
        },
      }),
    ]);
  });

  it('keeps the Ink fallback when intent reporting fails', () => {
    useChatStore.getState().addMessage('thread-1', {
      id: 'ink-user',
      role: 'user',
      content: '',
      inputKind: 'ink-intent',
    });
    handleStreamEvent(
      {
        type: 'tool_call',
        data: {
          toolCallId: 'intent-failed',
          title: 'report_ink_intent',
          status: 'pending',
          rawInput: { status: 'inferred', text: 'Do not display' },
          internalToolName: 'report_ink_intent',
        },
      },
      { threadId: 'thread-1', assistantId: 'assistant-1' },
    );
    handleStreamEvent(
      {
        type: 'tool_call_update',
        data: { toolCallId: 'intent-failed', status: 'failed' },
      },
      { threadId: 'thread-1', assistantId: 'assistant-1' },
    );

    expect(selectThreadMessages(useChatStore.getState(), 'thread-1')).toEqual([
      expect.objectContaining({ inkInterpretation: { state: 'failed' } }),
    ]);
  });

  it('preserves text, explicit extras, settings and captured sources across async saving', async () => {
    const gate = deferred();
    mocks.save.mockReturnValueOnce(gate.promise);
    useChatStore.getState().setThreadSettings(session.threadId, {
      modelId: 'model-1',
      reasoningEffort: 'high',
    });
    const prepared = request();
    prepared.invokedSkills = ['review'];
    const running = dispatchAgentTurn(prepared);
    useCanvasStore.getState()._setStateNoAutosave({ nodes: [] });
    useGesturePreviewStore.setState({ sketchStrokeSelection: {} });
    gate.resolve();
    const result = await running;
    expect(result.status).toBe('completed');
    expect(mocks.stream).toHaveBeenCalledWith(
      'Hello',
      'thread-1',
      'operate',
      expect.anything(),
      expect.objectContaining({
        inputKind: 'text',
        modelId: 'model-1',
        reasoningEffort: 'high',
        invokedSkills: ['review'],
        canvasContext: {
          selectedNodes: [
            expect.objectContaining({ id: 'note-1' }),
            expect.objectContaining({
              id: 'sketch-1',
              strokeIds: ['stroke-1'],
            }),
          ],
        },
      }),
    );
    expect(
      selectThreadMessages(useChatStore.getState(), session.threadId)[0],
    ).toMatchObject({
      role: 'user',
      selectedNodeIds: ['note-1', 'sketch-1'],
      selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
    });
  });

  it('sends Ink without consuming same-thread drafts, uploads, excerpts or skills', async () => {
    const attachment = {
      id: 'upload',
      type: 'text',
      content: 'private draft',
    } as unknown as ChatAttachment;
    useChatStore.getState().setDraft(session.threadId, 'Unsent draft');
    useChatStore.getState().addPendingAttachment(session.threadId, attachment);
    useChatStore.getState().setSelectionAttachment(attachment);
    await dispatchAgentTurn(request('ink-intent'));
    expect(mocks.stream.mock.calls[0][0]).toBe('');
    expect(mocks.stream.mock.calls[0][4]).toMatchObject({
      inputKind: 'ink-intent',
      attachments: undefined,
      invokedSkills: undefined,
    });
    const state = useChatStore.getState();
    expect(state.threadsById[session.threadId].draft).toBe('Unsent draft');
    expect(state.threadsById[session.threadId].pendingAttachments).toEqual([
      attachment,
    ]);
    expect(state.selectionAttachment).toBe(attachment);
  });

  it('preserves a selectable Question external binding for Ink', async () => {
    const binding = {
      kind: 'external' as const,
      profileId: 'profile-1',
      alias: 'External Agent',
    };
    useChatStore.getState().setAgentBinding(session.threadId, binding);
    const prepared = request('ink-intent', questionSession);

    expect(prepared.agentBinding).toEqual(binding);
    await dispatchAgentTurn(prepared);

    expect(mocks.stream).toHaveBeenCalledWith(
      '',
      'thread-1',
      'operate',
      expect.anything(),
      expect.objectContaining({ agentBinding: binding }),
    );
  });

  it('retries Ink from the stored typed input instead of current composer state', async () => {
    const attachment = {
      id: 'source-file',
      type: 'text',
      content: 'submitted source',
    } as unknown as ChatAttachment;
    const prepared = prepareAgentTurnRetry(
      session,
      {
        id: 'user-1',
        role: 'user',
        content: '',
        inputKind: 'ink-intent',
        attachments: [attachment],
        selectedNodeIds: ['note-1', 'sketch-1'],
        selectedStrokeIds: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
        invokedSkills: ['review'],
      },
      'operate',
    );

    await dispatchAgentTurn(prepared);

    expect(mocks.stream).toHaveBeenCalledWith(
      '',
      'thread-1',
      'operate',
      expect.anything(),
      expect.objectContaining({
        inputKind: 'ink-intent',
        attachments: [attachment],
        invokedSkills: ['review'],
        canvasContext: {
          selectedNodes: expect.arrayContaining([
            expect.objectContaining({ id: 'note-1' }),
            expect.objectContaining({
              id: 'sketch-1',
              strokeIds: ['stroke-1'],
            }),
          ]),
        },
      }),
    );
  });

  it('notifies acceptance only through the transport acceptance callback', async () => {
    const accepted = vi.fn();
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        callbacks.onEvent({
          type: 'meta',
          data: { threadId: 'thread-1', mode: 'operate' },
        });
        expect(accepted).not.toHaveBeenCalled();
        callbacks.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 8 });
        expect(accepted).toHaveBeenCalledWith({
          threadId: 'thread-1',
          turnStartSeq: 8,
        });
        callbacks.onComplete();
      },
    );
    await dispatchAgentTurn(request('ink-intent'), { onAccepted: accepted });
  });

  it('classifies an error after durable acceptance as a runtime failure', async () => {
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        callbacks.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 8 });
        callbacks.onError(new Error('Agent failed after starting'));
      },
    );

    await expect(
      dispatchAgentTurn(request('ink-intent')),
    ).resolves.toMatchObject({
      status: 'failed',
      accepted: { threadId: 'thread-1', turnStartSeq: 8 },
    });
  });

  it('retains the acceptance observer after an ambiguous transport failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
    const accepted = vi.fn();

    await expect(
      dispatchAgentTurn(request('ink-intent'), { onAccepted: accepted }),
    ).resolves.toMatchObject({ status: 'unknown' });

    const acceptance = { threadId: 'thread-1', turnStartSeq: 12 };
    observeAgentTurnAcceptance('canvas-1', acceptance);
    observeAgentTurnAcceptance('canvas-1', acceptance);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(acceptance);
  });

  it('blocks same-thread replacement until unknown acceptance is reconciled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
    const accepted = vi.fn();

    await expect(
      dispatchAgentTurn(request('ink-intent'), { onAccepted: accepted }),
    ).resolves.toMatchObject({ status: 'unknown' });

    await expect(
      dispatchAgentTurn(request('ink-intent')),
    ).resolves.toMatchObject({
      status: 'busy',
      error: {
        message:
          'The previous Agent turn is still awaiting acceptance reconciliation',
      },
    });
    expect(mocks.stream).toHaveBeenCalledTimes(1);

    observeAgentTurnAcceptance('canvas-1', {
      threadId: 'thread-1',
      turnStartSeq: 12,
    });
    expect(accepted).toHaveBeenCalledOnce();

    await expect(
      dispatchAgentTurn(request('ink-intent')),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  it('ignores stale reconnect reconciliation and does not reconcile a live replacement', async () => {
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) =>
        callbacks.onComplete(),
    );
    await dispatchAgentTurn(request());
    const oldRequestId = mocks.stream.mock.calls[0][4].requestId;
    const stopGate = deferred();
    mocks.stop.mockImplementationOnce(async () => {
      await stopGate.promise;
      return {
        stopped: false,
        acceptance: null,
        request: { id: oldRequestId, accepted: false },
      };
    });
    const reconciliation = reconcileAgentTurnAfterReconnect(
      session.ownerCanvasId,
      session.threadId,
    );
    observeAgentTurnAcceptance(session.ownerCanvasId, {
      threadId: session.threadId,
      turnStartSeq: 5,
      requestId: oldRequestId,
    });
    const streamGate = deferred();
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        await streamGate.promise;
        callbacks.onComplete();
      },
    );
    const accepted = vi.fn();
    const rejected = vi.fn();
    const replacement = dispatchAgentTurn(request(), {
      onAccepted: accepted,
      onAcceptanceRejected: rejected,
    });
    try {
      await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(2));
      await reconcileAgentTurnAfterReconnect(
        session.ownerCanvasId,
        session.threadId,
      );
      expect(mocks.stop).toHaveBeenCalledOnce();
      stopGate.resolve();
      await reconciliation;
      observeAgentTurnAcceptance(session.ownerCanvasId, {
        threadId: session.threadId,
        turnStartSeq: 6,
        requestId: mocks.stream.mock.calls[1][4].requestId,
      });
      expect(accepted).toHaveBeenCalledOnce();
      expect(rejected).not.toHaveBeenCalled();
    } finally {
      stopGate.resolve();
      streamGate.resolve();
      await reconciliation;
      await replacement;
    }
  });

  it('does not deliver a duplicate older acceptance to a newer turn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
    const olderAccepted = vi.fn();

    await dispatchAgentTurn(request('ink-intent'), {
      onAccepted: olderAccepted,
    });
    const olderAcceptance = { threadId: 'thread-1', turnStartSeq: 20 };
    observeAgentTurnAcceptance('canvas-1', olderAcceptance);
    expect(olderAccepted).toHaveBeenCalledExactlyOnceWith(olderAcceptance);

    const newerAccepted = vi.fn();
    mocks.stream.mockImplementationOnce(
      async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
        observeAgentTurnAcceptance('canvas-1', olderAcceptance);
        expect(newerAccepted).not.toHaveBeenCalled();
        callbacks.onAccepted?.({ threadId: 'thread-1', turnStartSeq: 21 });
        callbacks.onComplete();
      },
    );

    await expect(
      dispatchAgentTurn(request('ink-intent'), {
        onAccepted: newerAccepted,
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      accepted: { threadId: 'thread-1', turnStartSeq: 21 },
    });
    expect(olderAccepted).toHaveBeenCalledOnce();
    expect(newerAccepted).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 21,
    });
  });

  it('does not POST after a rejected save or leak its preparation claim', async () => {
    mocks.save.mockRejectedValueOnce(new Error('save conflict'));
    const result = await dispatchAgentTurn(request('ink-intent'));
    expect(result).toMatchObject({
      status: 'rejected',
      error: { message: 'save conflict' },
    });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
    expect(useChatStore.getState().threadsById['thread-1'].isPreparing).toBe(
      false,
    );
  });

  it('leaves server-owned Question lifecycle untouched when preparation saving fails', async () => {
    mocks.save.mockRejectedValueOnce(new Error('save conflict'));
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: {
            content: '',
            threadId: 'thread-1',
            status: 'idle',
            pendingInkIntentLabel: true,
          },
        },
        {
          id: 'sketch-1',
          type: 'sketch',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });

    const result = await dispatchAgentTurn(
      request('ink-intent', questionSession),
    );

    expect(result.status).toBe('rejected');
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('does not perform a second client lifecycle save before POST', async () => {
    mocks.save
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lifecycle save conflict'));

    const result = await dispatchAgentTurn(request('ink-intent'));

    expect(result.status).toBe('completed');
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.stream).toHaveBeenCalledOnce();
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('stops a Question while its preparation save is pending', async () => {
    const preparationSave = deferred();
    mocks.save.mockReturnValueOnce(preparationSave.promise);
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { content: '', threadId: 'thread-1', status: 'idle' },
        },
        {
          id: 'sketch-1',
          type: 'sketch',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });

    const running = dispatchAgentTurn(request('ink-intent', questionSession));
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());

    stopAgentTurn(questionSession);
    expect(mocks.stop).not.toHaveBeenCalled();
    preparationSave.resolve();

    await expect(running).resolves.toMatchObject({ status: 'stopped' });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('claims before validation so another surface cannot POST or attach', async () => {
    const gate = deferred();
    mocks.save.mockReturnValueOnce(gate.promise);
    const prepared = request('ink-intent');
    const running = dispatchAgentTurn(prepared);
    expect((await dispatchAgentTurn(prepared)).status).toBe('busy');
    expect(claimAgentStream('canvas-1', 'thread-1', 'attach')).toBeNull();
    gate.resolve();
    await running;
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it('allows node-less source-less text', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ nodes: [] });
    useGesturePreviewStore.setState({ sketchStrokeSelection: {} });
    await dispatchAgentTurn(request());
    expect(mocks.stream.mock.calls[0][4].canvasContext).toEqual({
      selectedNodes: [],
    });
  });

  it('sends and retries quote-only messages with the same structured snapshot', async () => {
    const quotedComments = [
      {
        quote: 'Original reply',
        contextBefore: 'Before ',
        contextAfter: ' after',
        comment: 'Explain this.',
      },
    ];
    const prepared = request();
    prepared.content = '';
    prepared.quotedComments = quotedComments;
    await dispatchAgentTurn(prepared);
    expect(mocks.stream.mock.calls[0][0]).toBe('');
    expect(mocks.stream.mock.calls[0][4].quotedComments).toEqual(
      quotedComments,
    );
    const message = selectThreadMessages(
      useChatStore.getState(),
      session.threadId,
    ).find((item) => item.role === 'user');
    expect(message).toMatchObject({ content: '', quotedComments });
    if (message?.role !== 'user') throw new Error('Missing user message');
    const retry = prepareAgentTurnRetry(session, message, 'operate');
    expect(retry.quotedComments).toEqual(quotedComments);
    await dispatchAgentTurn(retry);
    expect(mocks.stream.mock.calls[1][4].quotedComments).toEqual(
      quotedComments,
    );
  });

  it.each([true, false])(
    'clears quoted drafts before transport and restores only a rejected submission: %s',
    async (accepted) => {
      const store = useChatStore.getState();
      store.setDraft(session.threadId, 'General instructions');
      store.addQuotedComment(session.threadId, {
        quote: 'Original reply',
        contextBefore: '',
        contextAfter: '',
        comment: 'Explain this.',
      });
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          expect(
            useChatStore.getState().threadsById[session.threadId].draft,
          ).toBe('');
          expect(
            useChatStore.getState().threadsById[session.threadId]
              .pendingQuotedComments,
          ).toHaveLength(0);
          if (accepted) {
            callbacks.onAccepted?.({
              threadId: session.threadId,
              turnStartSeq: 5,
            });
            callbacks.onComplete();
          } else {
            callbacks.onError(
              new ApiError(400, {}, 'Request rejected before acceptance'),
            );
          }
        },
      );
      let hook!: UseAgentStreamReturn;
      function Harness() {
        hook = useAgentStream(session);
        return null;
      }
      container = document.createElement('div');
      root = createRoot(container);
      await act(async () => root?.render(createElement(Harness)));
      await act(async () =>
        hook.startStream('General instructions', 'operate'),
      );
      const current = useChatStore.getState().threadsById[session.threadId];
      expect(current.draft).toBe(accepted ? '' : 'General instructions');
      expect(current.pendingQuotedComments).toHaveLength(accepted ? 0 : 1);
      expect(mocks.stream.mock.calls[0][4].quotedComments).toEqual([
        {
          quote: 'Original reply',
          contextBefore: '',
          contextAfter: '',
          comment: 'Explain this.',
        },
      ]);
    },
  );

  describe('composer selection exclusion', () => {
    it.each([
      { external: false, anchored: false },
      { external: true, anchored: false },
      { external: false, anchored: true },
      { external: true, anchored: true },
    ])(
      'sends empty selection, preserves explicit context and retries the original sources: %j',
      async ({ external, anchored }) => {
        vi.spyOn(
          useAcpThreadChangesStore.getState(),
          'load',
        ).mockResolvedValue();
        const owner = anchored ? questionSession : session;
        const binding = external
          ? {
              kind: 'external' as const,
              profileId: 'profile-1',
              alias: 'Agent',
            }
          : { kind: 'internal' as const };
        const canvas = useCanvasStore.getState();
        canvas._setStateNoAutosave({
          nodes: [
            {
              id: 'frame-1',
              type: 'frame',
              selected: true,
              position: { x: 0, y: 0 },
              data: {},
            },
            {
              id: 'image-1',
              type: 'image',
              parentId: 'frame-1',
              position: { x: 0, y: 0 },
              data: { src: 'artifact.png' },
            },
            {
              id: 'sketch-1',
              type: 'sketch',
              parentId: 'frame-1',
              position: { x: 0, y: 0 },
              data: {},
            },
            ...(anchored
              ? [
                  {
                    id: 'question-1',
                    type: 'question',
                    selected: true,
                    position: { x: 0, y: 0 },
                    data: {
                      threadId: 'thread-1',
                      status: 'idle',
                      agentBinding: binding,
                    },
                  },
                ]
              : []),
          ],
        });
        const nodes = useCanvasStore.getState().nodes;
        const strokes = useGesturePreviewStore.getState().sketchStrokeSelection;
        const attachment: ChatAttachment = {
          type: 'text',
          source: 'upload',
          content: 'Explicit upload',
        };
        const excerpt: ChatAttachment = {
          type: 'text',
          source: 'excerpt',
          content: 'Explicit excerpt',
        };
        const chat = useChatStore.getState();
        chat.setAgentBinding(session.threadId, binding);
        chat.addPendingAttachment(session.threadId, attachment);
        chat.setSelectionAttachment(excerpt);
        chat.setExcludeCanvasSelection(session.threadId, true);
        chat.setDraft(session.threadId, 'Hello');
        let hook!: UseAgentStreamReturn;
        function Harness() {
          hook = useAgentStream(owner);
          return null;
        }
        container = document.createElement('div');
        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));
        await act(async () => hook.startStream('Hello', 'operate'));
        const sent = mocks.stream.mock.calls[0][4];
        expect(sent.canvasContext).toEqual({ selectedNodes: [] });
        expect(sent.attachments).toEqual([attachment, excerpt]);
        expect(sent.agentBinding).toEqual(binding);
        expect(sent.anchorNodeId).toBe(anchored ? 'question-1' : undefined);
        expect(
          selectThreadExcludeCanvasSelection(
            useChatStore.getState(),
            session.threadId,
          ),
        ).toBe(false);
        expect(useCanvasStore.getState().nodes).toBe(nodes);
        expect(useGesturePreviewStore.getState().sketchStrokeSelection).toBe(
          strokes,
        );
        const message = selectThreadMessages(
          useChatStore.getState(),
          session.threadId,
        ).find((item) => item.role === 'user');
        if (message?.role !== 'user') throw new Error('Missing user message');
        expect(message.selectedNodeIds).toBeUndefined();
        expect(message.selectedStrokeIds).toBeUndefined();
        await act(async () => hook.retryStream(message, 'operate'));
        expect(mocks.stream.mock.calls[1][4].canvasContext).toEqual({
          selectedNodes: [],
        });
        await act(async () => hook.startStream('Next message', 'operate'));
        expect(
          mocks.stream.mock.calls[2][4].canvasContext.selectedNodes,
        ).toEqual([
          {
            id: 'frame-1',
            type: 'frame',
            children: [
              { id: 'image-1', type: 'image', src: 'artifact.png' },
              { id: 'sketch-1', type: 'sketch', strokeIds: ['stroke-1'] },
            ],
          },
        ]);
      },
    );

    it('does not suppress explicit Ink intent or consume the composer exclusion', async () => {
      useChatStore.getState().setExcludeCanvasSelection(session.threadId, true);
      await dispatchAgentTurn(request('ink-intent'));
      expect(
        mocks.stream.mock.calls[0][4].canvasContext.selectedNodes,
      ).not.toEqual([]);
      expect(
        selectThreadExcludeCanvasSelection(
          useChatStore.getState(),
          session.threadId,
        ),
      ).toBe(true);
    });
  });

  describe('optimistic composer clearing', () => {
    let hook: UseAgentStreamReturn;
    const quote = {
      quote: 'Original reply',
      contextBefore: '',
      contextAfter: '',
      comment: 'Explain this.',
    };
    beforeEach(async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const store = useChatStore.getState();
      store.setDraft(session.threadId, 'Hello');
      store.addQuotedComment(session.threadId, quote);
      function Harness() {
        hook = useAgentStream(session);
        return null;
      }
      container = document.createElement('div');
      root = createRoot(container);
      await act(async () => root?.render(createElement(Harness)));
    });

    it('clears synchronously before saving and never clears a newer identical draft on acceptance', async () => {
      const saved = deferred();
      mocks.save.mockReturnValueOnce(saved.promise);
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          const store = useChatStore.getState();
          store.setDraft(session.threadId, 'Hello');
          store.addQuotedComment(session.threadId, quote);
          callbacks.onAccepted?.({
            threadId: session.threadId,
            turnStartSeq: 5,
          });
          callbacks.onComplete();
        },
      );
      await act(async () => {
        const running = hook.startStream('Hello', 'operate');
        const current = useChatStore.getState().threadsById[session.threadId];
        expect(current.draft).toBe('');
        expect(current.pendingQuotedComments).toEqual([]);
        expect(mocks.stream).not.toHaveBeenCalled();
        saved.resolve();
        await running;
      });
      const current = useChatStore.getState().threadsById[session.threadId];
      expect(current.draft).toBe('Hello');
      expect(current.pendingQuotedComments).toHaveLength(1);
    });

    it('restores the exact snapshot when preparation rejects before transport', async () => {
      const snapshot = useChatStore.getState().threadsById[session.threadId];
      mocks.save.mockRejectedValueOnce(new Error('Save conflict'));
      await act(async () => hook.startStream('Hello', 'operate'));
      const current = useChatStore.getState().threadsById[session.threadId];
      expect(current.draft).toBe(snapshot.draft);
      expect(current.pendingQuotedComments).toEqual(
        snapshot.pendingQuotedComments,
      );
      expect(mocks.stream).not.toHaveBeenCalled();
    });

    it.each(['preflight', 'transport'])(
      'restores selection exclusion with the rejected draft: %s',
      async (phase) => {
        useChatStore
          .getState()
          .setExcludeCanvasSelection(session.threadId, true);
        if (phase === 'preflight') {
          mocks.save.mockRejectedValueOnce(new Error('Save conflict'));
        } else {
          mocks.stream.mockImplementationOnce(
            async (
              _content,
              _thread,
              _mode,
              callbacks: AgentStreamCallbacks,
            ) => {
              callbacks.onError(new ApiError(400, {}, 'Rejected'));
            },
          );
        }
        await act(async () => hook.startStream('Hello', 'operate'));
        expect(
          selectThreadExcludeCanvasSelection(
            useChatStore.getState(),
            session.threadId,
          ),
        ).toBe(true);
        expect(
          useChatStore.getState().threadsById[session.threadId].draft,
        ).toBe('Hello');
      },
    );

    it('does not reset exclusion staged for the next draft when the previous turn is accepted', async () => {
      useChatStore.getState().setExcludeCanvasSelection(session.threadId, true);
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          const chat = useChatStore.getState();
          chat.setDraft(session.threadId, 'Next draft');
          chat.setExcludeCanvasSelection(session.threadId, true);
          callbacks.onAccepted?.({
            threadId: session.threadId,
            turnStartSeq: 5,
          });
          callbacks.onComplete();
        },
      );
      await act(async () => hook.startStream('Hello', 'operate'));
      expect(
        selectThreadExcludeCanvasSelection(
          useChatStore.getState(),
          session.threadId,
        ),
      ).toBe(true);
      expect(useChatStore.getState().threadsById[session.threadId].draft).toBe(
        'Next draft',
      );
    });

    it('clears a quote-only submission immediately', async () => {
      act(() => useChatStore.getState().setDraft(session.threadId, ''));
      await act(async () => {
        const running = hook.startStream('', 'operate');
        expect(
          useChatStore.getState().threadsById[session.threadId]
            .pendingQuotedComments,
        ).toEqual([]);
        await running;
      });
      expect(mocks.stream.mock.calls[0][0]).toBe('');
      expect(mocks.stream.mock.calls[0][4].quotedComments).toEqual([quote]);
    });

    it('queues a busy submission without changing the active stream claim', async () => {
      const claim = claimAgentStream('canvas-1', 'thread-1', 'post');
      if (!claim) throw new Error('Missing stream claim');
      try {
        await act(async () => hook.startStream('Hello', 'operate'));
        const current = useChatStore.getState().threadsById[session.threadId];
        expect(current.draft).toBe('');
        expect(current.pendingQuotedComments).toHaveLength(0);
        expect(current.queuedTurns).toMatchObject([
          {
            status: 'pending',
            prepared: { content: 'Hello', quotedComments: [quote] },
          },
        ]);
        expect(mocks.stream).not.toHaveBeenCalled();
        expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(true);
      } finally {
        claim.release();
      }
    });

    it('keeps a preflight-rejected snapshot retryable when the user has already started a new draft', async () => {
      mocks.save.mockImplementationOnce(async () => {
        useChatStore.getState().setDraft(session.threadId, 'Next draft');
        throw new Error('Save conflict');
      });
      await act(async () => hook.startStream('Hello', 'operate'));
      expect(useChatStore.getState().threadsById[session.threadId].draft).toBe(
        'Next draft',
      );
      const message = selectThreadMessages(
        useChatStore.getState(),
        session.threadId,
      ).find((item) => item.role === 'user');
      expect(message).toMatchObject({
        content: 'Hello',
        quotedComments: [quote],
        selectedNodeIds: ['note-1', 'sketch-1'],
      });
      if (message?.role !== 'user') throw new Error('Missing retry snapshot');
      const retry = prepareAgentTurnRetry(session, message, 'operate');
      expect(retry.content).toBe('Hello');
      expect(retry.quotedComments).toEqual([quote]);
      expect(
        selectThreadMessages(useChatStore.getState(), session.threadId).at(-1),
      ).toMatchObject({
        role: 'status',
        status: 'error',
        detail: 'Save conflict',
      });
      expect(mocks.stream).not.toHaveBeenCalled();
    });

    it.each(['text', 'quote'])(
      'keeps a newer %s draft instead of restoring a rejected submission',
      async (kind) => {
        mocks.stream.mockImplementationOnce(
          async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
            const store = useChatStore.getState();
            if (kind === 'text') store.setDraft(session.threadId, 'Next draft');
            else
              store.addQuotedComment(session.threadId, {
                ...quote,
                comment: 'Next comment.',
              });
            callbacks.onError(new ApiError(400, {}, 'Rejected'));
          },
        );
        await act(async () => hook.startStream('Hello', 'operate'));
        const current = useChatStore.getState().threadsById[session.threadId];
        expect(current.draft).toBe(kind === 'text' ? 'Next draft' : '');
        expect(
          current.pendingQuotedComments.map((item) => item.comment),
        ).toEqual(kind === 'quote' ? ['Next comment.'] : []);
        expect(
          selectThreadMessages(useChatStore.getState(), session.threadId),
        ).toContainEqual(
          expect.objectContaining({
            role: 'user',
            content: 'Hello',
            quotedComments: [quote],
          }),
        );
      },
    );

    it('does not restore an accepted submission after a runtime failure', async () => {
      mocks.stream.mockImplementationOnce(
        async (_content, _thread, _mode, callbacks: AgentStreamCallbacks) => {
          callbacks.onAccepted?.({
            threadId: session.threadId,
            turnStartSeq: 5,
          });
          callbacks.onError(new Error('Agent failed after acceptance'));
        },
      );
      await act(async () => hook.startStream('Hello', 'operate'));
      const current = useChatStore.getState().threadsById[session.threadId];
      expect(current.draft).toBe('');
      expect(current.pendingQuotedComments).toEqual([]);
    });

    it.each([true, false])(
      'waits for ambiguous acceptance to reconcile before deciding restoration: %s',
      async (accepted) => {
        mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
        await act(async () => hook.startStream('Hello', 'operate'));
        expect(
          useChatStore.getState().threadsById[session.threadId].draft,
        ).toBe('');
        expect(
          useChatStore.getState().threadsById[session.threadId]
            .pendingQuotedComments,
        ).toEqual([]);
        if (accepted) {
          act(() =>
            observeAgentTurnAcceptance('canvas-1', {
              threadId: session.threadId,
              turnStartSeq: 5,
            }),
          );
        } else {
          await act(async () => {
            stopAgentTurn(session);
            await vi.waitFor(() =>
              expect(
                useChatStore.getState().threadsById[session.threadId].draft,
              ).toBe('Hello'),
            );
          });
        }
        const current = useChatStore.getState().threadsById[session.threadId];
        expect(current.draft).toBe(accepted ? '' : 'Hello');
        expect(current.pendingQuotedComments).toHaveLength(accepted ? 0 : 1);
      },
    );
  });

  it('keeps a text run alive after Chat unmount and permits a new Chat to stop it', async () => {
    let hook!: UseAgentStreamReturn;
    function Harness() {
      hook = useAgentStream(session);
      return null;
    }
    const started = deferred();
    mocks.stream.mockImplementationOnce(
      async (
        _content,
        _thread,
        _mode,
        callbacks: AgentStreamCallbacks,
        options: { signal: AbortSignal },
      ) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        callbacks.onComplete();
      },
    );
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness)));
    let running!: Promise<void>;
    await act(async () => {
      running = hook.startStream('Hello', 'operate');
      await started.promise;
    });
    act(() => root?.unmount());
    root = undefined;
    expect(mocks.stream.mock.calls[0][4].signal.aborted).toBe(false);
    stopAgentTurn(session);
    await running;
    expect(mocks.stop).toHaveBeenCalledWith(
      'thread-1',
      'canvas-1',
      mocks.stream.mock.calls[0][4].requestId,
    );
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('applies stop acceptance before aborting the local stream', async () => {
    const started = deferred();
    const accepted = vi.fn();
    mocks.stop.mockResolvedValueOnce({
      stopped: true,
      acceptance: { threadId: 'thread-1', turnStartSeq: 9 },
    });
    mocks.stream.mockImplementationOnce(
      async (
        _content,
        _thread,
        _mode,
        callbacks: AgentStreamCallbacks,
        options: { signal: AbortSignal },
      ) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        callbacks.onComplete();
      },
    );
    const running = dispatchAgentTurn(request('ink-intent'), {
      onAccepted: accepted,
    });
    await started.promise;

    stopAgentTurn(session);

    await expect(running).resolves.toMatchObject({
      status: 'stopped',
      accepted: { threadId: 'thread-1', turnStartSeq: 9 },
    });
    expect(accepted).toHaveBeenCalledExactlyOnceWith({
      threadId: 'thread-1',
      turnStartSeq: 9,
    });
  });

  it('keeps request-scoped Stop available after the acceptance observer is consumed', async () => {
    const started = deferred();
    mocks.stream.mockImplementationOnce(
      async (_content, threadId, _mode, callbacks, options) => {
        callbacks.onAccepted({
          threadId,
          turnStartSeq: 10,
          requestId: options.requestId,
        });
        started.resolve();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        callbacks.onComplete();
      },
    );
    const running = dispatchAgentTurn(request());
    await started.promise;
    stopAgentTurn(session);
    await expect(running).resolves.toMatchObject({ status: 'stopped' });
    expect(mocks.stop).toHaveBeenCalledWith(
      'thread-1',
      'canvas-1',
      mocks.stream.mock.calls[0][4].requestId,
    );
  });

  it('ignores an old Stop response after a replacement request has claimed the thread', async () => {
    const stopGate = deferred();
    const firstGate = deferred();
    const secondGate = deferred();
    const started = deferred();
    mocks.stop.mockImplementationOnce(async () => {
      await stopGate.promise;
      return { stopped: true, acceptance: null };
    });
    mocks.stream.mockImplementation(
      async (_content, threadId, _mode, callbacks, options) => {
        const first = mocks.stream.mock.calls.length === 1;
        callbacks.onAccepted({
          threadId,
          turnStartSeq: first ? 1 : 2,
          requestId: options.requestId,
        });
        if (!first) started.resolve();
        await (first ? firstGate.promise : secondGate.promise);
        expect(options.signal.aborted).toBe(false);
        callbacks.onEvent({ type: 'done', data: { message: 'Answer' } });
        callbacks.onComplete();
      },
    );
    const first = dispatchAgentTurn(request());
    await vi.waitFor(() => expect(mocks.stream).toHaveBeenCalledOnce());
    stopAgentTurn(session);
    firstGate.resolve();
    await first;
    const second = dispatchAgentTurn(request());
    await started.promise;
    stopGate.resolve();
    await Promise.resolve();
    expect(mocks.stream.mock.calls[1][4].signal.aborted).toBe(false);
    secondGate.resolve();
    await second;
  });

  it('releases an unknown acceptance observer after a definitive pre-acceptance stop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.stream.mockRejectedValueOnce(new Error('Connection lost'));
    const acceptanceRejected = vi.fn();

    await expect(
      dispatchAgentTurn(request('ink-intent'), {
        onAcceptanceRejected: acceptanceRejected,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });

    mocks.stop.mockResolvedValueOnce({ stopped: true, acceptance: null });
    stopAgentTurn(session);
    await vi.waitFor(() => expect(acceptanceRejected).toHaveBeenCalledOnce());

    await expect(
      dispatchAgentTurn(request('ink-intent')),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(mocks.stream).toHaveBeenCalledTimes(2);
  });

  it('keeps monitoring when the stop outcome is unknown', async () => {
    const started = deferred();
    const finish = deferred();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mocks.stop.mockRejectedValueOnce(new Error('offline'));
    mocks.stream.mockImplementationOnce(
      async (
        _content,
        _thread,
        _mode,
        callbacks: AgentStreamCallbacks,
        options: { signal: AbortSignal },
      ) => {
        started.resolve();
        await finish.promise;
        expect(options.signal.aborted).toBe(false);
        callbacks.onEvent({ type: 'done', data: { message: 'Answer' } });
        callbacks.onComplete();
      },
    );
    const running = dispatchAgentTurn(request('ink-intent'));
    await started.promise;

    stopAgentTurn(session);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());

    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(true);
    expect(
      selectThreadMessages(useChatStore.getState(), 'thread-1').some(
        (message) =>
          message.role === 'status' && message.status === 'interrupted',
      ),
    ).toBe(false);
    finish.resolve();
    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(false);
  });

  it('keeps monitoring when the server reports no active turn to stop', async () => {
    const started = deferred();
    const finish = deferred();
    mocks.stop.mockResolvedValueOnce({ stopped: false, acceptance: null });
    mocks.stream.mockImplementationOnce(
      async (
        _content,
        _thread,
        _mode,
        callbacks: AgentStreamCallbacks,
        options: { signal: AbortSignal },
      ) => {
        started.resolve();
        await finish.promise;
        expect(options.signal.aborted).toBe(false);
        callbacks.onEvent({ type: 'done', data: { message: 'Answer' } });
        callbacks.onComplete();
      },
    );
    const running = dispatchAgentTurn(request('ink-intent'));
    await started.promise;

    stopAgentTurn(session);
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());

    expect(hasAgentStreamClaim('canvas-1', 'thread-1')).toBe(true);
    expect(
      selectThreadMessages(useChatStore.getState(), 'thread-1').some(
        (message) =>
          message.role === 'status' && message.status === 'interrupted',
      ),
    ).toBe(false);
    finish.resolve();
    await expect(running).resolves.toMatchObject({ status: 'completed' });
  });
});
