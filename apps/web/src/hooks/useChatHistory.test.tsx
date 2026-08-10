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

import { useChatHistory } from './useChatHistory';

const apiMocks = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  reconnectStream: vi.fn(async () => false),
}));

vi.mock('@/api/agent', () => ({
  agentApi: {
    fetchHistory: apiMocks.fetchHistory,
    reconnectStream: apiMocks.reconnectStream,
  },
}));

vi.mock('@/store/canvasStore', () => {
  const state = { canvasId: 'canvas-1' };
  const useCanvasStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useCanvasStore.getState = () => state;
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
const SESSION = {
  threadId: THREAD_ID,
  canvasId: CANVAS_ID,
  ownerCanvasId: CANVAS_ID,
  conversationView: null,
};

function Harness() {
  useChatHistory(SESSION, noopSetIsLoading);
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

async function renderHarness(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
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
  apiMocks.reconnectStream.mockReset();
  apiMocks.reconnectStream.mockResolvedValue(false);
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

    await renderHarness();

    // Attaching here would replay the in-flight turn under a second
    // assistantId and render the answer twice.
    expect(apiMocks.reconnectStream).not.toHaveBeenCalled();
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
});
