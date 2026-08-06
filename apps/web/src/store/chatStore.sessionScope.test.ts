// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Characterization tests for `chatStore`'s session-scoping behaviour.
 *
 * These lock down what is per-thread today versus what is still a global
 * singleton, so the Preview Workspace migration (which normalizes the store
 * into one complete object per thread) has a regression net to refactor
 * against. See `docs/proposals/unified-preview-workspace.md`.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  selectCurrentBinding,
  selectCurrentHistoryLoaded,
  selectCurrentIsLoading,
  selectCurrentMessages,
  selectThreadBinding,
  selectThreadDraft,
  selectThreadHistoryLoaded,
  selectThreadMessages,
  selectThreadPendingAttachments,
  selectThreadSettings,
  useChatStore,
} from './chatStore';

import type { ChatMessage } from './chatTypes';
import type {
  AgentBinding,
  AgentConversationView,
  ChatAttachment,
} from '@huabu/shared';

const INTERNAL: AgentBinding = { kind: 'internal' };
const EXTERNAL: AgentBinding = {
  kind: 'external',
  alias: 'Claude Code',
  profileId: 'profile-1',
};

const STAGED_ATTACHMENT: ChatAttachment = {
  type: 'text',
  source: 'upload',
  content: 'staged',
  label: 'x',
};

function resetStore() {
  useChatStore.setState({
    threadsById: {},
    threadId: 'thread-initial',
    lastAction: 'ask',
    threadMap: {},
    bindingMap: {},
    viewingQuestionThread: null,
    questionReplayByCanvas: {},
    selectionAttachment: null,
    _savedCanvasThreadId: undefined,
    _savedCanvasBinding: undefined,
    _savedCanvasLastAction: undefined,
  });
}

/** The binding of whichever thread is currently visible. */
function currentBinding() {
  return selectCurrentBinding(useChatStore.getState());
}

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content };
}

function questionView(
  canvasId: string,
  nodeId: string,
  threadId: string,
): AgentConversationView {
  return {
    presentationAnchor: { canvasId, nodeId },
    conversationOwner: { canvasId, nodeId, threadId },
  };
}

beforeEach(resetStore);

describe('chatStore per-thread caches', () => {
  it('keeps messages, history-loaded and loading flags keyed by thread', () => {
    const s = useChatStore.getState();

    s.addMessage('thread-a', userMessage('m1', 'hello a'));
    s.addMessage('thread-b', userMessage('m2', 'hello b'));
    s.setHistoryLoaded('thread-a', true);
    s.setThreadLoading('thread-b', true);

    useChatStore.setState({ threadId: 'thread-a' });
    expect(selectCurrentMessages(useChatStore.getState())).toHaveLength(1);
    expect(selectCurrentHistoryLoaded(useChatStore.getState())).toBe(true);
    expect(selectCurrentIsLoading(useChatStore.getState())).toBe(false);

    useChatStore.setState({ threadId: 'thread-b' });
    const current = selectCurrentMessages(useChatStore.getState())[0];
    expect(current.role === 'user' && current.content).toBe('hello b');
    expect(selectCurrentHistoryLoaded(useChatStore.getState())).toBe(false);
    expect(selectCurrentIsLoading(useChatStore.getState())).toBe(true);
  });

  it('returns a stable empty array for threads with no cache entry', () => {
    const first = selectCurrentMessages(useChatStore.getState());
    const second = selectCurrentMessages(useChatStore.getState());
    expect(first).toBe(second);
    expect(first).toHaveLength(0);
  });
});

describe('chatStore per-thread agent binding', () => {
  it('binds each thread independently', () => {
    const s = useChatStore.getState();
    s.setAgentBinding('thread-a', EXTERNAL);

    const state = useChatStore.getState();
    expect(selectThreadBinding(state, 'thread-a')).toEqual(EXTERNAL);
    expect(selectThreadBinding(state, 'thread-b')).toEqual(INTERNAL);
  });

  it('keeps per-thread built-in settings apart', () => {
    const s = useChatStore.getState();
    s.setThreadSettings('thread-a', {
      modelId: 'model-a',
      reasoningEffort: 'high',
    });

    const state = useChatStore.getState();
    expect(selectThreadSettings(state, 'thread-a')).toEqual({
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    expect(selectThreadSettings(state, 'thread-b')).toEqual({
      modelId: null,
      reasoningEffort: null,
    });
  });
});

describe('chatStore staged attachments', () => {
  it('keeps staged attachments with their own thread', () => {
    const s = useChatStore.getState();
    s.addPendingAttachment('thread-a', STAGED_ATTACHMENT);

    const state = useChatStore.getState();
    expect(selectThreadPendingAttachments(state, 'thread-a')).toHaveLength(1);
    expect(selectThreadPendingAttachments(state, 'thread-b')).toEqual([]);
  });

  it('survives a canvas switch instead of being discarded', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    const canvasThread = useChatStore.getState().threadId;
    s.addPendingAttachment(canvasThread, STAGED_ATTACHMENT);

    s.switchToCanvas('canvas-2');
    s.switchToCanvas('canvas-1');

    expect(
      selectThreadPendingAttachments(useChatStore.getState(), canvasThread),
    ).toHaveLength(1);
  });
});

describe('chatStore shared selection context', () => {
  it('shows the same selection excerpt to every thread', () => {
    const s = useChatStore.getState();
    s.setSelectionAttachment({
      type: 'text',
      source: 'excerpt',
      content: 'selected',
      label: 'y',
    });

    useChatStore.setState({ threadId: 'thread-other' });
    expect(useChatStore.getState().selectionAttachment?.content).toBe(
      'selected',
    );
  });
});

describe('chatStore switchToCanvas', () => {
  it('mints one thread per canvas and restores it on return', () => {
    const s = useChatStore.getState();

    s.switchToCanvas('canvas-1');
    const first = useChatStore.getState().threadId;

    s.switchToCanvas('canvas-2');
    const second = useChatStore.getState().threadId;
    expect(second).not.toBe(first);

    s.switchToCanvas('canvas-1');
    expect(useChatStore.getState().threadId).toBe(first);
    expect(useChatStore.getState().threadMap).toEqual({
      'canvas-1': first,
      'canvas-2': second,
    });
  });

  it('remembers each canvas binding', () => {
    const s = useChatStore.getState();

    s.switchToCanvas('canvas-1');
    s.setAgentBinding(useChatStore.getState().threadId, EXTERNAL, 'canvas-1');

    s.switchToCanvas('canvas-2');
    expect(currentBinding()).toEqual(INTERNAL);

    s.switchToCanvas('canvas-1');
    expect(currentBinding()).toEqual(EXTERNAL);
  });

  it('drops a dangling question view when moving to a canvas with no replay', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    s.openQuestionThread(questionView('canvas-1', 'node-1', 'thread-q'));
    expect(useChatStore.getState().viewingQuestionThread).not.toBeNull();

    s.switchToCanvas('canvas-2');
    expect(useChatStore.getState().viewingQuestionThread).toBeNull();
    expect(useChatStore.getState()._savedCanvasThreadId).toBeUndefined();
  });

  it('restores a persisted replay and realigns threadMap to the saved canvas thread', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    const canvasThread = useChatStore.getState().threadId;

    s.openQuestionThread(
      questionView('canvas-1', 'node-1', 'thread-q'),
      EXTERNAL,
      'canvas-1',
    );
    s.switchToCanvas('canvas-2');
    s.switchToCanvas('canvas-1');

    const state = useChatStore.getState();
    expect(state.threadId).toBe('thread-q');
    expect(currentBinding()).toEqual(EXTERNAL);
    expect(state.viewingQuestionThread?.presentationAnchor.nodeId).toBe(
      'node-1',
    );
    expect(state.threadMap['canvas-1']).toBe(canvasThread);
    expect(state._savedCanvasThreadId).toBe(canvasThread);
  });
});

describe('chatStore clearMessages', () => {
  it('mints a fresh thread, seeds it loaded-and-empty, and resets the binding', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    s.setAgentBinding(useChatStore.getState().threadId, EXTERNAL, 'canvas-1');
    const previous = useChatStore.getState().threadId;
    s.addPendingAttachment(previous, STAGED_ATTACHMENT);

    s.clearMessages('canvas-1');

    const state = useChatStore.getState();
    expect(state.threadId).not.toBe(previous);
    expect(selectThreadMessages(state, state.threadId)).toEqual([]);
    expect(selectThreadHistoryLoaded(state, state.threadId)).toBe(true);
    expect(state.threadMap['canvas-1']).toBe(state.threadId);
    expect(currentBinding()).toEqual(INTERNAL);
    expect(state.bindingMap['canvas-1']).toEqual(INTERNAL);
    // A brand-new thread starts with nothing staged.
    expect(selectThreadPendingAttachments(state, state.threadId)).toEqual([]);
    expect(state.lastAction).toBe('ask');
  });

  it('can start the new thread already bound to an agent and mode', () => {
    useChatStore
      .getState()
      .clearMessages('canvas-1', { binding: EXTERNAL, lastAction: 'operate' });

    const state = useChatStore.getState();
    expect(currentBinding()).toEqual(EXTERNAL);
    expect(state.bindingMap['canvas-1']).toEqual(EXTERNAL);
    expect(state.lastAction).toBe('operate');
  });
});

describe('chatStore question thread lifecycle', () => {
  it('round-trips thread, binding and lastAction through open/close', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    s.setAgentBinding(useChatStore.getState().threadId, EXTERNAL, 'canvas-1');
    s.setLastAction('operate');
    const canvasThread = useChatStore.getState().threadId;

    s.openQuestionThread(
      questionView('canvas-1', 'node-1', 'thread-q'),
      INTERNAL,
      'canvas-1',
    );
    expect(useChatStore.getState().threadId).toBe('thread-q');
    expect(currentBinding()).toEqual(INTERNAL);

    // A follow-up send inside the replay may pollute the global mode.
    useChatStore.getState().setLastAction('ask');

    s.closeQuestionThread('canvas-1');
    const state = useChatStore.getState();
    expect(state.viewingQuestionThread).toBeNull();
    expect(state.threadId).toBe(canvasThread);
    expect(currentBinding()).toEqual(EXTERNAL);
    expect(state.lastAction).toBe('operate');
    expect(state.questionReplayByCanvas['canvas-1']).toBeUndefined();
  });

  it('keeps the pre-replay canvas state when hopping between two questions', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    const canvasThread = useChatStore.getState().threadId;

    s.openQuestionThread(
      questionView('canvas-1', 'node-1', 'thread-q1'),
      INTERNAL,
      'canvas-1',
    );
    s.openQuestionThread(
      questionView('canvas-1', 'node-2', 'thread-q2'),
      INTERNAL,
      'canvas-1',
    );

    expect(useChatStore.getState().threadId).toBe('thread-q2');
    expect(useChatStore.getState()._savedCanvasThreadId).toBe(canvasThread);

    s.closeQuestionThread('canvas-1');
    expect(useChatStore.getState().threadId).toBe(canvasThread);
  });

  it('bumps openSequence when the same question is reopened', () => {
    const s = useChatStore.getState();
    const view = questionView('canvas-1', 'node-1', 'thread-q');

    s.openQuestionThread(view, INTERNAL, 'canvas-1', 'bottom');
    const first = useChatStore.getState().viewingQuestionThread?.openSequence;

    s.openQuestionThread(view, INTERNAL, 'canvas-1', 'last-user');
    const second = useChatStore.getState().viewingQuestionThread;
    expect(second?.openSequence).toBe((first ?? 0) + 1);
    expect(second?.openPosition).toBe('last-user');
  });

  it('rolls back to canvas chat when the on-screen question node is deleted', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    const canvasThread = useChatStore.getState().threadId;
    s.openQuestionThread(
      questionView('canvas-1', 'node-1', 'thread-q'),
      INTERNAL,
      'canvas-1',
    );

    s.handleQuestionNodesDeleted('canvas-1', ['node-1']);

    const state = useChatStore.getState();
    expect(state.viewingQuestionThread).toBeNull();
    expect(state.threadId).toBe(canvasThread);
    expect(state.questionReplayByCanvas['canvas-1']).toBeUndefined();
  });

  it('drops an off-screen replay pointer whose node was deleted', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    s.openQuestionThread(
      questionView('canvas-1', 'node-1', 'thread-q'),
      INTERNAL,
      'canvas-1',
    );
    s.switchToCanvas('canvas-2');

    s.handleQuestionNodesDeleted('canvas-1', ['node-1']);
    expect(
      useChatStore.getState().questionReplayByCanvas['canvas-1'],
    ).toBeUndefined();
  });

  it('validateQuestionReplay drops pointers whose node is gone', () => {
    const s = useChatStore.getState();
    s.switchToCanvas('canvas-1');
    s.openQuestionThread(
      questionView('canvas-1', 'node-1', 'thread-q'),
      INTERNAL,
      'canvas-1',
    );
    s.switchToCanvas('canvas-2');

    s.validateQuestionReplay('canvas-1', new Set(['node-9']));
    expect(
      useChatStore.getState().questionReplayByCanvas['canvas-1'],
    ).toBeUndefined();
  });
});

describe('chatStore evictInactiveThreads', () => {
  it('pins the current, loading and saved-canvas threads', () => {
    const s = useChatStore.getState();
    for (const tid of ['t1', 't2', 't3', 't4']) {
      s.addMessage(tid, userMessage(`m-${tid}`, tid));
      s.setDraft(tid, `draft ${tid}`);
      s.setHistoryLoaded(tid, true);
    }
    useChatStore.setState({ threadId: 't1', _savedCanvasThreadId: 't3' });
    s.setThreadLoading('t2', true);

    s.evictInactiveThreads(1);

    const state = useChatStore.getState();
    expect(Object.keys(state.threadsById).sort()).toEqual(['t1', 't2', 't3']);
    expect(selectThreadDraft(state, 't4')).toBe('');
    expect(selectThreadHistoryLoaded(state, 't4')).toBe(false);
    expect(selectThreadDraft(state, 't1')).toBe('draft t1');
  });

  it('is a no-op while the cache is under the limit', () => {
    const s = useChatStore.getState();
    s.addMessage('t1', userMessage('m1', 'a'));
    const before = useChatStore.getState().threadsById;

    s.evictInactiveThreads(10);
    expect(useChatStore.getState().threadsById).toBe(before);
  });
});
