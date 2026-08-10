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
