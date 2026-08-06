// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { selectThreadDraft, useChatStore } from './chatStore';

const testStorage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return storage;
});

describe('chatStore composer drafts', () => {
  beforeEach(() => {
    testStorage.clear();
    useChatStore.setState({
      threadsById: {},
      threadId: 'thread-a',
    });
  });

  it('isolates drafts by thread and removes cleared entries', () => {
    const { setDraft } = useChatStore.getState();

    setDraft('thread-a', 'first draft');
    setDraft('thread-b', 'second draft');
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe(
      'first draft',
    );
    expect(selectThreadDraft(useChatStore.getState(), 'thread-b')).toBe(
      'second draft',
    );

    setDraft('thread-b', '');
    expect(selectThreadDraft(useChatStore.getState(), 'thread-b')).toBe('');
    expect(selectThreadDraft(useChatStore.getState(), 'thread-a')).toBe(
      'first draft',
    );
  });
});

describe('chatStore question compose binding', () => {
  beforeEach(() => {
    testStorage.clear();
    useChatStore.setState({
      threadId: 'canvas-thread',
      agentBinding: { kind: 'internal' },
      lastAction: 'ask',
      bindingMap: {
        'canvas-a': {
          kind: 'external',
          profileId: 'canvas-default',
          alias: 'Canvas Default',
        },
      },
      messagesByThread: {},
      historyLoadedThreads: new Set(),
      viewingQuestionThread: null,
    });
  });

  const view = {
    presentationAnchor: { canvasId: 'canvas-a', nodeId: 'node-question' },
    conversationOwner: {
      canvasId: 'canvas-a',
      nodeId: 'node-question',
      threadId: 'thread-question',
    },
  };

  it('uses an explicitly persisted binding for a prebound Question Node', () => {
    useChatStore.getState().openQuestionCompose(view, {
      canvasId: 'canvas-a',
      binding: {
        kind: 'external',
        profileId: 'fixed-profile',
        alias: 'Fixed Agent',
      },
    });

    expect(useChatStore.getState().agentBinding).toEqual({
      kind: 'external',
      profileId: 'fixed-profile',
      alias: 'Fixed Agent',
    });
  });

  it('keeps the Canvas default for an ordinary unbound Question Node', () => {
    useChatStore.getState().openQuestionCompose(view, {
      canvasId: 'canvas-a',
    });

    expect(useChatStore.getState().agentBinding).toEqual({
      kind: 'external',
      profileId: 'canvas-default',
      alias: 'Canvas Default',
    });
  });
});
