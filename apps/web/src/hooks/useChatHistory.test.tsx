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

import { claimAgentStream } from './agentStreamCoordinator';
import { useChatHistory } from './useChatHistory';

import type { ChatSession } from './useChatSession';

const apiMocks = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  reconnectStream: vi.fn(async () => ({ status: 'inactive' as const })),
}));

const canvasMock = vi.hoisted(() => ({
  state: {
    canvasId: 'canvas-1',
    nodes: [] as Array<{
      id: string;
      type: string;
      data: Record<string, unknown>;
    }>,
    worldReferences: {},
    patchNodeSilent: vi.fn(),
  },
}));

vi.mock('@/api/agent', () => ({
  agentApi: {
    fetchHistory: apiMocks.fetchHistory,
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

vi.mock('@/store/conversationOwner', () => ({
  ConversationIntegrityError: class ConversationIntegrityError extends Error {},
  filterClientOwnedQuestionPatch: vi.fn(
    (_source: unknown, patch: Record<string, unknown>) => patch,
  ),
  patchConversationOwnerNode: vi.fn(),
  refreshConversationPresentation: vi.fn(),
  resolveConversationOwnerSource: vi.fn(() => undefined),
  validateConversationView: vi.fn(async () => {}),
}));

vi.mock('@/hooks/useActivelyViewingQuestion', () => ({
  isActivelyViewingQuestion: vi.fn(() => false),
}));

vi.mock('@/store/acpThreadChangesStore', () => ({
  useAcpThreadChangesStore: { getState: () => ({}) },
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
  useChatHistory(session, noopSetIsLoading);
  return null;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** History ends on a user turn: the state that arms the reconnect. */
function seedStore(isStreaming: boolean) {
  useChatStore.setState({
    threadMap: { [CANVAS_ID]: THREAD_ID },
    threadsById: {
      [THREAD_ID]: {
        messages: [{ id: 'm1', role: 'user', content: 'hi' }],
        draft: '',
        historyLoaded: true,
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
  useChatStore.persist.setOptions({
    storage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  apiMocks.fetchHistory.mockReset();
  apiMocks.fetchHistory.mockResolvedValue({
    threadId: THREAD_ID,
    messages: [{ role: 'user', content: 'hi' }],
  });
  apiMocks.reconnectStream.mockReset();
  apiMocks.reconnectStream.mockResolvedValue({ status: 'inactive' });
  canvasMock.state.nodes = [];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('useChatHistory reconnect', () => {
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

  it('attaches when an already-loaded Agent Node becomes running', async () => {
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
          agentBindingPolicy: 'fixed',
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

    expect(apiMocks.fetchHistory).toHaveBeenCalledWith(THREAD_ID, CANVAS_ID);
    expect(apiMocks.reconnectStream).toHaveBeenCalledTimes(1);
  });
});
