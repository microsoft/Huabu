// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  selectThreadDraft,
  selectThreadQuotedComments,
  useChatStore,
} from './chatStore';

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

  it('keeps quoted comments thread-local and supports editing and removal', () => {
    const store = useChatStore.getState();
    const comment = {
      quote: ' \nPassage  one\n\n    indented\nEnd. ',
      contextBefore: 'Before ',
      contextAfter: ' after',
      comment: ' Explain. ',
    };
    store.setDraft('a', 'General instructions');
    store.addQuotedComment('a', comment);
    expect(selectThreadQuotedComments(useChatStore.getState(), 'a')[0]).toEqual(
      {
        ...comment,
        draftId: expect.any(String),
        quote: comment.quote.trim(),
        comment: 'Explain.',
      },
    );
    expect(selectThreadQuotedComments(useChatStore.getState(), 'b')).toEqual(
      [],
    );
    store.updateQuotedComment('a', 0, 'More detail.');
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'a')[0]?.comment,
    ).toBe('More detail.');
    store.removeQuotedComment('a', 0);
    expect(selectThreadQuotedComments(useChatStore.getState(), 'a')).toEqual(
      [],
    );
    expect(selectThreadDraft(useChatStore.getState(), 'a')).toBe(
      'General instructions',
    );
  });

  it('keeps preparing threads reactive, runtime-only and pinned until released', () => {
    const chat = useChatStore.getState();
    chat.setThreadPreparing('preparing', true);
    chat.setDraft('idle', '');
    const state = useChatStore.getState();
    expect(state.threadsById.preparing.isPreparing).toBe(true);
    chat.setThreadPreparing('preparing', true);
    expect(useChatStore.getState()).toBe(state);
    expect(
      useChatStore.persist.getOptions().partialize?.(state),
    ).not.toHaveProperty('threadsById');
    chat.evictInactiveThreads(0);
    expect(useChatStore.getState().threadsById.preparing).toBeDefined();
    expect(useChatStore.getState().threadsById.idle).toBeUndefined();
    chat.setThreadPreparing('preparing', false);
    chat.evictInactiveThreads(0);
    expect(useChatStore.getState().threadsById.preparing).toBeUndefined();
  });

  it('consumes only the submitted draft snapshot and retains additions and edits', () => {
    const store = useChatStore.getState();
    const comment = {
      quote: 'Passage',
      contextBefore: '',
      contextAfter: '',
      comment: 'Explain.',
    };
    store.setDraft('a', 'Original draft');
    store.addQuotedComment('a', comment);
    store.addQuotedComment('a', { ...comment, comment: 'Second.' });
    const sent = selectThreadQuotedComments(useChatStore.getState(), 'a');
    store.setDraft('a', 'Next message');
    store.updateQuotedComment('a', 1, 'Edited while sending');
    store.addQuotedComment('a', { ...comment, comment: 'New comment.' });
    store.consumeDraft('a', 'Original draft', sent);
    expect(selectThreadDraft(useChatStore.getState(), 'a')).toBe(
      'Next message',
    );
    expect(
      selectThreadQuotedComments(useChatStore.getState(), 'a').map(
        (item) => item.comment,
      ),
    ).toEqual(['Edited while sending', 'New comment.']);
    store.consumeDraft(
      'a',
      'Next message',
      selectThreadQuotedComments(useChatStore.getState(), 'a'),
    );
    expect(selectThreadDraft(useChatStore.getState(), 'a')).toBe('');
    expect(selectThreadQuotedComments(useChatStore.getState(), 'a')).toEqual(
      [],
    );
  });

  it('restores a rejected submission and preserves its quoted-comment identities', () => {
    const store = useChatStore.getState();
    store.setDraft('a', 'Original draft');
    store.addQuotedComment('a', {
      quote: 'Passage',
      contextBefore: '',
      contextAfter: '',
      comment: 'Explain.',
    });
    const sent = selectThreadQuotedComments(useChatStore.getState(), 'a');
    store.consumeDraft('a', 'Original draft', sent);
    store.restoreDraftIfEmpty('a', 'Original draft', sent);
    expect(selectThreadDraft(useChatStore.getState(), 'a')).toBe(
      'Original draft',
    );
    expect(selectThreadQuotedComments(useChatStore.getState(), 'a')).toEqual(
      sent,
    );
    expect(selectThreadDraft(useChatStore.getState(), 'b')).toBe('');
  });

  it.each(['Next message', ' '])(
    'does not overwrite newer text %j when restoring a rejected submission',
    (text) => {
      const store = useChatStore.getState();
      store.setDraft('a', text);
      store.restoreDraftIfEmpty('a', 'Original draft', []);
      expect(selectThreadDraft(useChatStore.getState(), 'a')).toBe(text);
    },
  );

  it('does not overwrite a newer quote-only draft when restoring a rejected submission', () => {
    const store = useChatStore.getState();
    store.addQuotedComment('a', {
      quote: 'New passage',
      contextBefore: '',
      contextAfter: '',
      comment: 'New comment.',
    });
    const next = selectThreadQuotedComments(useChatStore.getState(), 'a');
    store.restoreDraftIfEmpty('a', 'Original draft', []);
    expect(selectThreadDraft(useChatStore.getState(), 'a')).toBe('');
    expect(selectThreadQuotedComments(useChatStore.getState(), 'a')).toEqual(
      next,
    );
  });

  it('consumes unchanged restored entries by draft identity while preserving edits and new copies', () => {
    const store = useChatStore.getState();
    const comment = {
      quote: 'Passage',
      contextBefore: '',
      contextAfter: '',
      comment: 'Explain.',
    };
    store.addQuotedComment('a', comment);
    store.addQuotedComment('a', { ...comment, comment: 'Second.' });
    const submitted = selectThreadQuotedComments(useChatStore.getState(), 'a');
    store.setQuotedComments('a', []);
    store.setQuotedComments('a', submitted);
    const restored = selectThreadQuotedComments(useChatStore.getState(), 'a');
    expect(restored[0]).not.toBe(submitted[0]);
    expect(restored.map((item) => item.draftId)).toEqual(
      submitted.map((item) => item.draftId),
    );
    store.updateQuotedComment('a', 1, 'Edited after restoring.');
    store.addQuotedComment('a', comment);
    store.consumeDraft('a', '', submitted);
    const remaining = selectThreadQuotedComments(useChatStore.getState(), 'a');
    expect(remaining.map((item) => item.comment)).toEqual([
      'Edited after restoring.',
      'Explain.',
    ]);
    expect(remaining[0].draftId).toBe(submitted[1].draftId);
    expect(remaining[1].draftId).not.toBe(submitted[0].draftId);
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
