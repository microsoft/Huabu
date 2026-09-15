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
    });
  });

  describe('chatStore paged history', () => {
    beforeEach(() => {
      useChatStore.setState({ threadsById: {} });
    });

    it('prepends older messages without duplicating an overlapping page', () => {
      const store = useChatStore.getState();
      store.setMessages('thread-a', [
        {
          id: 'turn-2:0',
          historyTurnId: 'turn-2',
          role: 'user',
          content: 'newer',
        },
      ]);

      store.prependHistoryMessages('thread-a', [
        {
          id: 'turn-1:0',
          historyTurnId: 'turn-1',
          role: 'user',
          content: 'older',
        },
        {
          id: 'turn-2:0',
          historyTurnId: 'turn-2',
          role: 'user',
          content: 'newer',
        },
      ]);

      expect(
        useChatStore
          .getState()
          .threadsById['thread-a']?.messages.map((message) => message.id),
      ).toEqual(['turn-1:0', 'turn-2:0']);
    });

    it('replaces the overlapping newest suffix while preserving older pages', () => {
      const store = useChatStore.getState();
      store.setMessages('thread-a', [
        {
          id: 'turn-1:0',
          historyTurnId: 'turn-1',
          role: 'user',
          content: 'older',
        },
        {
          id: 'turn-2:0',
          historyTurnId: 'turn-2',
          role: 'user',
          content: 'pending',
        },
      ]);

      store.mergeLatestHistoryMessages('thread-a', [
        {
          id: 'turn-2:0',
          historyTurnId: 'turn-2',
          role: 'user',
          content: 'complete',
        },
        {
          id: 'turn-2:1',
          historyTurnId: 'turn-2',
          role: 'assistant',
          segments: [{ kind: 'text', text: 'answer' }],
        },
      ]);

      expect(
        useChatStore
          .getState()
          .threadsById['thread-a']?.messages.map((message) => message.id),
      ).toEqual(['turn-1:0', 'turn-2:0', 'turn-2:1']);
    });

    it('appends a non-overlapping newest turn without dropping older pages', () => {
      const store = useChatStore.getState();
      store.setMessages('thread-a', [
        {
          id: 'turn-1:0',
          historyTurnId: 'turn-1',
          role: 'user',
          content: 'older',
        },
        {
          id: 'live-user',
          role: 'user',
          content: 'pending',
        },
      ]);

      store.mergeLatestHistoryMessages('thread-a', [
        {
          id: 'turn-2:0',
          historyTurnId: 'turn-2',
          role: 'user',
          content: 'newest',
        },
      ]);

      expect(
        useChatStore
          .getState()
          .threadsById['thread-a']?.messages.map((message) => message.id),
      ).toEqual(['turn-1:0', 'turn-2:0']);
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
