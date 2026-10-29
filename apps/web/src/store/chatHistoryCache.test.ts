// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  historyMessageIds,
  MAX_HISTORY_PAGES,
  trimHistoryPages,
} from './chatHistoryCache';
import { useChatStore } from './chatStore';

import type { ChatHistoryPage } from './chatHistoryCache';
import type { ChatMessage } from './chatTypes';

function fixture() {
  const messages: ChatMessage[] = Array.from({ length: 30 }, (_, index) => ({
    id: `message-${index}`,
    historyTurnId: `turn-${index}`,
    role: 'user',
    content: `Question ${index}`,
  }));
  const pages: ChatHistoryPage[] = Array.from({ length: 10 }, (_, index) => ({
    before: index === 9 ? undefined : `cursor-${index}`,
    limit: 3,
    messageIds: messages
      .slice(index * 3, index * 3 + 3)
      .map((message) => message.id),
    loaded: true,
  }));
  return { messages, pages };
}

describe('cursor-backed history cache', () => {
  beforeEach(() => useChatStore.setState({ threadsById: {}, threadMap: {} }));
  it('bounds page bodies, retaining the directory, visible page and newest page', () => {
    const { messages, pages } = fixture();
    const result = trimHistoryPages(pages, messages, ['message-0']);
    expect(result.historyPages.filter((page) => page.loaded)).toHaveLength(
      MAX_HISTORY_PAGES,
    );
    expect(result.messages).toHaveLength(15);
    expect(result.messages.map((message) => message.id)).toContain('message-0');
    expect(result.messages.map((message) => message.id)).toContain(
      'message-29',
    );
    expect(historyMessageIds(result.historyPages, result.messages)).toEqual(
      messages.map((message) => message.id),
    );
    expect(result.historyPages.map((page) => page.before)).toEqual(
      pages.map((page) => page.before),
    );
  });

  it('keeps active turns, local messages and unresolved permission pages', () => {
    const { messages, pages } = fixture();
    messages[15] = { ...messages[15]!, historyTurnActive: true };
    messages[18] = {
      id: 'message-18',
      historyTurnId: 'turn-18',
      role: 'assistant',
      segments: [
        {
          kind: 'permission',
          requestId: 'permission',
          toolCall: { toolCallId: 'tool', title: 'Read' },
          options: [],
        },
      ],
    };
    messages.push({ id: 'live', role: 'user', content: 'Unpersisted' });
    const result = trimHistoryPages(pages, messages, ['message-0']);
    expect(result.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(['message-15', 'message-18', 'live']),
    );
  });

  it('refills an evicted page in order without duplicating or replacing the live tail', () => {
    const { messages, pages } = fixture();
    const store = useChatStore.getState();
    const threadId = store.createThread({ binding: { kind: 'internal' } });
    store.setMessages(threadId, [
      ...messages,
      { id: 'live', role: 'user', content: 'Still streaming' },
    ]);
    store.setHistoryPages(threadId, pages);
    store.trimHistoryCache(threadId, ['message-0']);
    const missing = useChatStore
      .getState()
      .threadsById[threadId]!.historyPages!.find((page) => !page.loaded)!;
    store.refillHistoryPage(
      threadId,
      missing,
      messages.filter((message) => missing.messageIds.includes(message.id)),
    );
    const thread = useChatStore.getState().threadsById[threadId]!;
    expect(thread.messages.at(-1)?.id).toBe('live');
    expect(
      thread.historyPages?.find((page) => page.before === missing.before)
        ?.loaded,
    ).toBe(true);
    expect(thread.messages.map((message) => message.id)).toEqual([
      ...new Set(thread.messages.map((message) => message.id)),
    ]);
    expect(
      thread.messages.filter((message) =>
        missing.messageIds.includes(message.id),
      ),
    ).toHaveLength(3);
  });

  it('ignores a refill after the directory has been replaced', () => {
    const { messages, pages } = fixture();
    const store = useChatStore.getState();
    const threadId = store.createThread({ binding: { kind: 'internal' } });
    store.setMessages(threadId, []);
    store.setHistoryPages(threadId, []);
    store.refillHistoryPage(threadId, pages[0]!, messages);
    expect(useChatStore.getState().threadsById[threadId]?.messages).toEqual([]);
  });

  it('retains the page directory when a whole inactive thread loses its bodies', () => {
    const { messages, pages } = fixture();
    const store = useChatStore.getState();
    const threadId = store.createThread({ binding: { kind: 'internal' } });
    store.setMessages(threadId, messages);
    store.setHistoryPages(threadId, pages);
    store.evictInactiveThreads(0);
    const thread = useChatStore.getState().threadsById[threadId];
    expect(thread?.messages).toEqual([]);
    expect(thread?.historyLoaded).toBe(false);
    expect(thread?.historyPages?.map((page) => page.before)).toEqual(
      pages.map((page) => page.before),
    );
    expect(thread?.historyPages?.every((page) => !page.loaded)).toBe(true);
  });

  it('does not evict drafts or unpersisted local turns at the thread boundary', () => {
    const store = useChatStore.getState();
    store.setDraft('draft', 'Unfinished input');
    store.addMessage('local', {
      id: 'local-user',
      role: 'user',
      content: 'Not persisted',
    });
    store.evictInactiveThreads(0);
    expect(useChatStore.getState().threadsById.draft?.draft).toBe(
      'Unfinished input',
    );
    expect(useChatStore.getState().threadsById.local?.messages).toHaveLength(1);
  });

  it('pins every active view of a thread until its last lease is released', () => {
    const { messages, pages } = fixture();
    const store = useChatStore.getState();
    store.setMessages('visible', messages);
    store.setHistoryPages('visible', pages);
    const first = store.retainHistoryView('visible');
    const second = store.retainHistoryView('visible');
    first();
    first();
    store.evictInactiveThreads(0);
    expect(useChatStore.getState().threadsById.visible?.messages).toHaveLength(
      30,
    );
    second();
    store.evictInactiveThreads(0);
    expect(useChatStore.getState().threadsById.visible?.messages).toEqual([]);
    expect(
      useChatStore.getState().threadsById.visible?.historyPages,
    ).toHaveLength(10);
  });

  it('protects independent viewports even when their first visible IDs match', () => {
    const { messages, pages } = fixture();
    const store = useChatStore.getState();
    store.setMessages('shared', messages);
    store.setHistoryPages('shared', pages);
    store.retainHistoryView('shared', 'left');
    const releaseRight = store.retainHistoryView('shared', 'right');
    store.trimHistoryCache('shared', ['message-0'], 'left');
    store.trimHistoryCache('shared', ['message-0'], 'right');
    expect(
      useChatStore.getState().threadsById.shared?.historyViewports?.right,
    ).toEqual(['message-0']);

    store.setMessages('shared', messages);
    store.setHistoryPages('shared', pages);
    store.trimHistoryCache('shared', ['message-29'], 'left');
    expect(
      useChatStore
        .getState()
        .threadsById.shared?.messages.map((message) => message.id),
    ).toEqual(expect.arrayContaining(['message-0', 'message-29']));

    releaseRight();
    const afterRelease = useChatStore.getState().threadsById.shared;
    store.trimHistoryCache('shared', ['message-0'], 'right');
    expect(useChatStore.getState().threadsById.shared).toBe(afterRelease);
    expect(afterRelease?.historyViewports).not.toHaveProperty('right');
  });
});
