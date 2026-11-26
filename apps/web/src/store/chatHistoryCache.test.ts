// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  historyMessageIds,
  keepUndeliveredMessages,
  MAX_HISTORY_PAGES,
  trimHistoryPages,
} from './chatHistoryCache';
import { useChatStore } from './chatStore';

import type { ChatHistoryPage } from './chatHistoryCache';
import type { ChatMessage } from './chatTypes';
import type { AssistantToolPart } from '@huabu/shared';

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
  it('retains loaded tool details on summary refresh but not across turn generations', () => {
    const full: AssistantToolPart = {
      kind: 'tool',
      variant: 'generic',
      toolCallId: 'tool',
      title: 'Read',
      content: [
        { type: 'content', content: { type: 'text', text: 'loaded body' } },
      ],
      detail: { state: 'inline', turnRef: 'generation-1' },
    };
    const message = (part: AssistantToolPart): ChatMessage => ({
      id: 'message',
      historyTurnId: 'group',
      role: 'assistant',
      segments: [part],
    });
    const { content: _content, ...base } = full;
    const summary: AssistantToolPart = {
      ...base,
      detail: { state: 'deferred', turnRef: 'generation-1', summary: {} },
    };
    const store = useChatStore.getState();
    store.setMessages('thread', [message(full)]);
    store.mergeLatestHistoryMessages('thread', [message(summary)]);
    expect(useChatStore.getState().threadsById.thread?.messages).toEqual([
      message(full),
    ]);
    store.setMessages('thread', [message(summary)]);
    expect(useChatStore.getState().threadsById.thread?.messages).toEqual([
      message(full),
    ]);
    const replaced: AssistantToolPart = {
      ...summary,
      detail: { state: 'deferred', turnRef: 'generation-2', summary: {} },
    };
    store.setMessages('thread', [message(replaced)]);
    expect(useChatStore.getState().threadsById.thread?.messages).toEqual([
      message(replaced),
    ]);
  });
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

describe('undelivered messages across a history rebuild', () => {
  const turn = (id: string, text: string): ChatMessage[] => [
    { id: `${id}:0`, historyTurnId: id, role: 'user', content: text },
    { id: `${id}:1`, historyTurnId: id, role: 'assistant', segments: [] },
  ];
  const undelivered = (id: string): ChatMessage[] => [
    { id, role: 'user', content: `Not sent ${id}` },
    { id: `${id}-status`, role: 'status', status: 'error', localOnly: true },
  ];
  const ids = (messages: ChatMessage[]) =>
    messages.map((message) => message.id);

  it('keeps each one directly after the turn that preceded it', () => {
    const current = [
      ...turn('t1', 'First'),
      ...undelivered('a'),
      ...undelivered('b'),
      // Sent after them and still local when history is rebuilt.
      { id: 'live', role: 'user', content: 'Second' } as ChatMessage,
    ];
    const next = [...turn('t1', 'First'), ...turn('t2', 'Second')];
    expect(ids(keepUndeliveredMessages(current, next))).toEqual([
      't1:0',
      't1:1',
      'a',
      'a-status',
      'b',
      'b-status',
      't2:0',
      't2:1',
    ]);
  });

  it('puts one first when the turn before it is no longer loaded, and never twice', () => {
    const current = [...turn('old', 'Earlier'), ...undelivered('a')];
    const rebuilt = keepUndeliveredMessages(current, turn('new', 'Later'));
    expect(ids(rebuilt)).toEqual(['a', 'a-status', 'new:0', 'new:1']);
    expect(keepUndeliveredMessages(rebuilt, rebuilt)).toBe(rebuilt);
  });

  it('leaves a local message with an ordinary error to be replaced by history', () => {
    const current: ChatMessage[] = [
      ...turn('t1', 'First'),
      { id: 'live', role: 'user', content: 'Second' },
      { id: 'live-status', role: 'status', status: 'error' },
    ];
    const next = [...turn('t1', 'First'), ...turn('t2', 'Second')];
    expect(keepUndeliveredMessages(current, next)).toBe(next);
  });

  it('lets a newer turn stand in for a send still being confirmed', () => {
    const current: ChatMessage[] = [
      ...turn('t1', 'First'),
      { id: 'live', role: 'user', content: 'Second' },
      {
        id: 'live-status',
        role: 'status',
        status: 'confirming',
        localOnly: true,
      },
    ];
    const received = [...turn('t1', 'First'), ...turn('t2', 'Second')];
    expect(keepUndeliveredMessages(current, received)).toEqual(received);
    // Nothing newer in history: the send is still only local.
    expect(ids(keepUndeliveredMessages(current, turn('t1', 'First')))).toEqual([
      't1:0',
      't1:1',
      'live',
      'live-status',
    ]);
  });

  it('is listed where the transcript has it, not after the paged history', () => {
    const messages = [
      ...turn('t1', 'First'),
      ...undelivered('a'),
      ...turn('t2', 'Second'),
      { id: 'live', role: 'user', content: 'Third' } as ChatMessage,
    ];
    const pages: ChatHistoryPage[] = [
      { limit: 3, loaded: true, messageIds: ['t1:0', 't1:1', 't2:0', 't2:1'] },
    ];
    expect(historyMessageIds(pages, messages)).toEqual([
      't1:0',
      't1:1',
      'a',
      'a-status',
      't2:0',
      't2:1',
      'live',
    ]);
    // Ahead of everything loaded when nothing precedes it.
    expect(
      historyMessageIds(pages, [...undelivered('a'), ...turn('t2', 'Second')]),
    ).toEqual(['t1:0', 't1:1', 'a', 'a-status', 't2:0', 't2:1']);
  });

  it('survives a merge of the latest history window', () => {
    const store = useChatStore.getState();
    store.setMessages('kept', [...turn('t1', 'First'), ...undelivered('a')]);
    store.mergeLatestHistoryMessages('kept', [
      ...turn('t1', 'First'),
      ...turn('t2', 'Second'),
    ]);
    expect(
      ids(useChatStore.getState().threadsById.kept?.messages ?? []),
    ).toEqual(['t1:0', 't1:1', 'a', 'a-status', 't2:0', 't2:1']);
  });
});
