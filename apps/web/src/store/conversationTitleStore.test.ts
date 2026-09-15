// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import {
  queryConversationTitles,
  setConversationTitle,
} from '@/api/conversationTitles';

import {
  clearPendingConversationTitle,
  conversationTitleKey,
  flushPendingConversationTitle,
  getConversationTitle,
  needsConversationTitleRefresh,
  receiveAcpConversationTitle,
  refreshConversationTitles,
  renameConversationTitle,
  retryConversationTitle,
  seedConversationTitle,
  useConversationTitleStore,
} from './conversationTitleStore';

import type {
  ConversationTitle,
  QueryConversationTitlesResponse,
} from '@huabu/shared';

vi.mock('@/api/conversationTitles', () => ({
  queryConversationTitles: vi.fn(),
  setConversationTitle: vi.fn(),
}));
const query = vi.mocked(queryConversationTitles);
const save = vi.mocked(setConversationTitle);
const key = conversationTitleKey('canvas', 'thread');
const current = () => getConversationTitle('canvas', 'thread');
const systemLikeTitle =
  'You are a helpful assistant collaborating with a user inside **Huabu**, an infinite visual Space. The user works on an i';
const invalidAcpTitles = ['', '   ', 'x'.repeat(121)];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useConversationTitleStore.setState({
    entries: {},
    pending: {},
    refreshEpoch: 0,
  });
  query.mockImplementation(async ({ threadIds }) => ({
    titles: Object.fromEntries(
      threadIds.map((id) => [
        id,
        { title: `Title ${id}`, source: 'generated' },
      ]),
    ),
  }));
  save.mockImplementation(async (_canvas, _thread, { title }) => ({
    title,
    source: 'user',
  }));
});

describe('conversation titles', () => {
  it('uses a first-line fallback immediately and never replaces it with a later prompt', () => {
    seedConversationTitle('canvas', 'thread', '  First prompt\nSecond line ');
    seedConversationTitle('canvas', 'thread', 'Later prompt');
    expect(current()).toEqual({ title: 'First prompt', source: 'fallback' });
  });

  it.each([
    ['# **Research plan**', 'Research plan'],
    ['Intro\n## Specific topic', 'Specific topic'],
    ['\n> - **Topic** and `code`', 'Topic and code'],
    ['A'.repeat(80), 'A'.repeat(50)],
  ])(
    'seeds the same fallback that the server returns for %s',
    async (prompt, expected) => {
      seedConversationTitle('canvas', 'thread', prompt);
      expect(current()).toEqual({ title: expected, source: 'fallback' });
      query.mockResolvedValueOnce({
        titles: { thread: { title: expected, source: 'fallback' } },
      });
      await refreshConversationTitles('canvas', ['thread']);
      expect(current()).toEqual({ title: expected, source: 'fallback' });
    },
  );

  it('flushes a rehydrated manual title when the durable thread has no title', async () => {
    localStorage.setItem(
      'huabu.conversationTitleDrafts',
      JSON.stringify({
        version: 1,
        state: { pending: { [key]: 'Manual name' } },
      }),
    );
    await useConversationTitleStore.persist.rehydrate();
    query.mockResolvedValueOnce({
      titles: { thread: { title: null, source: null } },
    });
    await refreshConversationTitles('canvas', ['thread']);
    expect(save).toHaveBeenCalledExactlyOnceWith('canvas', 'thread', {
      title: 'Manual name',
    });
    expect(current()).toEqual({ title: 'Manual name', source: 'user' });
    expect(useConversationTitleStore.getState().pending).toEqual({});
  });

  it('keeps an untitled missing thread pending and retries when it becomes durable', async () => {
    await renameConversationTitle('canvas', 'thread', 'Keep me', true);
    query.mockResolvedValue({
      titles: { thread: { title: null, source: null } },
    });
    save.mockRejectedValueOnce(
      new ApiError(404, { code: 'thread_not_found' }, 'Not durable'),
    );
    await refreshConversationTitles('canvas', ['thread']);
    expect(current().title).toBe('Keep me');
    expect(needsConversationTitleRefresh('canvas', 'thread')).toBe(true);
    expect(
      useConversationTitleStore.getState().entries[key].error,
    ).toBeUndefined();
    await refreshConversationTitles('canvas', ['thread']);
    expect(save).toHaveBeenCalledTimes(2);
    expect(useConversationTitleStore.getState().pending).toEqual({});
  });

  it('batches all cold threads in chunks of at most 100 and dedupes overlapping requests', async () => {
    const result = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValue(result.promise);
    const ids = Array.from({ length: 205 }, (_, index) => `thread-${index}`);
    const first = refreshConversationTitles('canvas', ids);
    const duplicate = refreshConversationTitles('canvas', ids.slice(90, 160));
    expect(query.mock.calls.map(([body]) => body.threadIds.length)).toEqual([
      100, 100, 5,
    ]);
    result.resolve({
      titles: Object.fromEntries(
        ids.map((id) => [id, { title: id, source: 'generated' }]),
      ),
    });
    await Promise.all([first, duplicate]);
    expect(getConversationTitle('canvas', 'thread-204').title).toBe(
      'thread-204',
    );
  });

  it('isolates identical thread IDs across Canvas namespaces, including delayed responses', async () => {
    const old = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValueOnce(old.promise);
    const first = refreshConversationTitles('old', ['thread']);
    await refreshConversationTitles('new', ['thread']);
    old.resolve({ titles: { thread: { title: 'Old canvas', source: 'acp' } } });
    await first;
    expect(getConversationTitle('old', 'thread').title).toBe('Old canvas');
    expect(getConversationTitle('new', 'thread').title).toBe('Title thread');
  });

  it('surfaces query failure, releases in-flight dedupe, and allows retry', async () => {
    query.mockRejectedValueOnce(new Error('Offline'));
    await refreshConversationTitles('canvas', ['thread']);
    expect(useConversationTitleStore.getState().entries[key].error).toBe(
      'Offline',
    );
    await retryConversationTitle('canvas', 'thread');
    expect(current().title).toBe('Title thread');
    expect(
      useConversationTitleStore.getState().entries[key].error,
    ).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('accepts generated query upgrades despite intervening live ACP revisions', async () => {
    const result = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValueOnce(result.promise);
    const loading = refreshConversationTitles('canvas', ['thread']);
    receiveAcpConversationTitle('canvas', 'thread', ' ACP name ');
    receiveAcpConversationTitle('canvas', 'thread', 'Newer ACP name');
    receiveAcpConversationTitle('canvas', 'thread', '  ');
    receiveAcpConversationTitle('canvas', 'thread', null);
    result.resolve({
      titles: { thread: { title: 'Generated', source: 'generated' } },
    });
    await loading;
    expect(current()).toEqual({ title: 'Generated', source: 'generated' });
    receiveAcpConversationTitle('canvas', 'thread', 'Late ACP name');
    expect(current()).toEqual({ title: 'Generated', source: 'generated' });
  });

  it.each(['acp', 'fallback'] as const)(
    'protects live ACP against stale %s query responses',
    async (source) => {
      const result = deferred<QueryConversationTitlesResponse>();
      query.mockReturnValueOnce(result.promise);
      const loading = refreshConversationTitles('canvas', ['thread']);
      receiveAcpConversationTitle('canvas', 'thread', 'Latest ACP');
      result.resolve({ titles: { thread: { title: 'Older', source } } });
      await loading;
      expect(current()).toEqual({ title: 'Latest ACP', source: 'acp' });
    },
  );

  it('upgrades cached ACP through a later backend query and rejects subsequent ACP downgrades', async () => {
    receiveAcpConversationTitle('canvas', 'thread', 'ACP fallback');
    expect(needsConversationTitleRefresh('canvas', 'thread')).toBe(true);
    await refreshConversationTitles('canvas', ['thread']);
    expect(current()).toEqual({ title: 'Title thread', source: 'generated' });
    expect(needsConversationTitleRefresh('canvas', 'thread')).toBe(false);
    receiveAcpConversationTitle('canvas', 'thread', 'Late ACP');
    query.mockResolvedValueOnce({
      titles: { thread: { title: 'Saved ACP', source: 'acp' } },
    });
    await refreshConversationTitles('canvas', ['thread']);
    expect(current()).toEqual({ title: 'Title thread', source: 'generated' });
  });

  it('protects manual priority against both live ACP and older server responses', async () => {
    const result = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValueOnce(result.promise);
    const loading = refreshConversationTitles('canvas', ['thread']);
    await renameConversationTitle('canvas', 'thread', ' My title ', false);
    receiveAcpConversationTitle('canvas', 'thread', 'Agent title');
    result.resolve({
      titles: { thread: { title: 'Old user title', source: 'user' } },
    });
    await loading;
    expect(current()).toEqual({ title: 'My title', source: 'user' });
  });

  it.each(['before', 'after'] as const)(
    'ignores a query started during rename that returns %s save completion',
    async (order) => {
      query.mockResolvedValueOnce({
        titles: { thread: { title: 'Original', source: 'user' } },
      });
      await refreshConversationTitles('canvas', ['thread']);
      const saving = deferred<ConversationTitle>();
      save.mockReturnValueOnce(saving.promise);
      const rename = renameConversationTitle(
        'canvas',
        'thread',
        'Renamed',
        false,
      );
      const result = deferred<QueryConversationTitlesResponse>();
      query.mockReturnValueOnce(result.promise);
      const loading = refreshConversationTitles('canvas', ['thread']);
      if (order === 'after') {
        saving.resolve({ title: 'Renamed', source: 'user' });
        await rename;
      }
      result.resolve({
        titles: { thread: { title: 'Original', source: 'user' } },
      });
      await loading;
      expect(current()).toEqual({ title: 'Renamed', source: 'user' });
      if (order === 'before') {
        saving.resolve({ title: 'Renamed', source: 'user' });
        await rename;
      }
      expect(current().title).toBe('Renamed');
      query.mockResolvedValueOnce({
        titles: { thread: { title: 'Later server rename', source: 'user' } },
      });
      await refreshConversationTitles('canvas', ['thread']);
      expect(current().title).toBe('Later server rename');
    },
  );

  it('ignores an in-save query after a failed rename rolls back', async () => {
    seedConversationTitle('canvas', 'thread', 'Original');
    const saving = deferred<ConversationTitle>();
    save.mockReturnValueOnce(saving.promise);
    const rename = renameConversationTitle(
      'canvas',
      'thread',
      'Renamed',
      false,
    );
    const rejection = expect(rename).rejects.toThrow('Offline');
    const result = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValueOnce(result.promise);
    const loading = refreshConversationTitles('canvas', ['thread']);
    saving.reject(new Error('Offline'));
    await rejection;
    result.resolve({
      titles: { thread: { title: 'Stale user title', source: 'user' } },
    });
    await loading;
    expect(current()).toEqual({ title: 'Original', source: 'fallback' });
    expect(useConversationTitleStore.getState().entries[key].failedTitle).toBe(
      'Renamed',
    );
  });

  it('preserves a first-send rename across thread_not_found, reload, and later creation', async () => {
    seedConversationTitle('canvas', 'thread', 'First prompt');
    save.mockRejectedValueOnce(
      new ApiError(404, { code: 'thread_not_found' }, 'Not durable yet'),
    );
    await renameConversationTitle('canvas', 'thread', 'Keep me', false);
    expect(current()).toEqual({ title: 'Keep me', source: 'user' });
    expect(useConversationTitleStore.getState().pending[key]).toBe('Keep me');
    expect(
      useConversationTitleStore.getState().entries[key].error,
    ).toBeUndefined();
    const persisted = localStorage.getItem('huabu.conversationTitleDrafts');
    expect(persisted).not.toBeNull();
    useConversationTitleStore.setState({ entries: {}, pending: {} });
    localStorage.setItem('huabu.conversationTitleDrafts', persisted ?? '');
    await useConversationTitleStore.persist.rehydrate();
    expect(current().title).toBe('Keep me');
    await refreshConversationTitles('canvas', ['thread']);
    expect(save).toHaveBeenLastCalledWith('canvas', 'thread', {
      title: 'Keep me',
    });
    expect(current().title).toBe('Keep me');
    expect(useConversationTitleStore.getState().pending[key]).toBeUndefined();
  });

  it('does not turn unrelated 404 failures into pending intent', async () => {
    seedConversationTitle('canvas', 'thread', 'Original');
    save.mockRejectedValueOnce(new ApiError(404, {}, 'Route not found'));
    await expect(
      renameConversationTitle('canvas', 'thread', 'New', false),
    ).rejects.toThrow('Route not found');
    expect(current().title).toBe('Original');
    expect(useConversationTitleStore.getState().pending[key]).toBeUndefined();
  });

  it('does not restore an older rename when its delayed creation-race response arrives', async () => {
    const old = deferred<ConversationTitle>();
    save.mockReturnValueOnce(old.promise);
    const first = renameConversationTitle('canvas', 'thread', 'Old', false);
    await renameConversationTitle('canvas', 'thread', 'Latest', false);
    old.reject(
      new ApiError(404, { code: 'thread_not_found' }, 'Not durable yet'),
    );
    await first;
    expect(current().title).toBe('Latest');
    expect(useConversationTitleStore.getState().pending[key]).toBeUndefined();
  });

  it('normalizes streamed ACP names like the durable server title', () => {
    receiveAcpConversationTitle('canvas', 'thread', '  Topic\n\tname  ');
    expect(current().title).toBe('Topic name');
    receiveAcpConversationTitle('canvas', 'thread', 'x'.repeat(150));
    expect(current().title).toBe('Topic name');
    receiveAcpConversationTitle('canvas', 'thread', 'x'.repeat(120));
    expect(current().title).toHaveLength(120);
  });

  it.each(invalidAcpTitles)(
    'rejects blank or overlong streamed/query ACP without displacing a fallback: %s',
    async (title) => {
      seedConversationTitle('canvas', 'thread', 'Actual user question');
      const result = deferred<QueryConversationTitlesResponse>();
      query.mockReturnValueOnce(result.promise);
      const loading = refreshConversationTitles('canvas', ['thread']);
      receiveAcpConversationTitle('canvas', 'thread', title);
      expect(current()).toEqual({
        title: 'Actual user question',
        source: 'fallback',
      });
      result.resolve({
        titles: { thread: { title: 'Generated topic', source: 'generated' } },
      });
      await loading;
      expect(current()).toEqual({
        title: 'Generated topic',
        source: 'generated',
      });
      query.mockResolvedValueOnce({
        titles: { thread: { title, source: 'acp' } },
      });
      await refreshConversationTitles('canvas', ['thread']);
      expect(current()).toEqual({
        title: 'Generated topic',
        source: 'generated',
      });
    },
  );

  it.each(invalidAcpTitles)(
    'ignores invalid cached ACP and allows a server fallback: %s',
    async (title) => {
      useConversationTitleStore.setState({
        entries: {
          [key]: {
            value: { title, source: 'acp' },
            revision: 7,
            durable: true,
          },
        },
      });
      expect(current()).toEqual({ title: null, source: null });
      expect(needsConversationTitleRefresh('canvas', 'thread')).toBe(true);
      query.mockResolvedValueOnce({
        titles: { thread: { title: 'Actual question', source: 'fallback' } },
      });
      await refreshConversationTitles('canvas', ['thread']);
      expect(current()).toEqual({
        title: 'Actual question',
        source: 'fallback',
      });
      expect(useConversationTitleStore.getState().entries[key].value).toEqual(
        current(),
      );
    },
  );

  it('clears invalid cached/query ACP rank and allows immediate prompt seeding', async () => {
    useConversationTitleStore.setState({
      entries: {
        [key]: {
          value: { title: 'x'.repeat(121), source: 'acp' },
          revision: 0,
          durable: true,
        },
      },
    });
    query.mockResolvedValueOnce({
      titles: { thread: { title: 'x'.repeat(121), source: 'acp' } },
    });
    await refreshConversationTitles('canvas', ['thread']);
    expect(useConversationTitleStore.getState().entries[key].value).toEqual({
      title: null,
      source: null,
    });
    seedConversationTitle('canvas', 'thread', 'Real question');
    expect(current()).toEqual({ title: 'Real question', source: 'fallback' });
  });

  it('retains valid ACP when invalid metadata or lower-ranked queries arrive', async () => {
    receiveAcpConversationTitle('canvas', 'thread', 'Valid ACP');
    for (const title of invalidAcpTitles) {
      receiveAcpConversationTitle('canvas', 'thread', title);
      query.mockResolvedValueOnce({
        titles: { thread: { title, source: 'acp' } },
      });
      await refreshConversationTitles('canvas', ['thread']);
      expect(current()).toEqual({ title: 'Valid ACP', source: 'acp' });
    }
    query.mockResolvedValueOnce({
      titles: { thread: { title: 'Prompt', source: 'fallback' } },
    });
    await refreshConversationTitles('canvas', ['thread']);
    expect(current().title).toBe('Valid ACP');
  });

  it.each([systemLikeTitle, systemLikeTitle.replace(/\*/g, '')])(
    'accepts system-like ACP text within 120 characters as a fallback: %s',
    async (title) => {
      expect(title.length).toBeLessThanOrEqual(120);
      seedConversationTitle('canvas', 'thread', 'First prompt');
      receiveAcpConversationTitle('canvas', 'thread', title);
      expect(current()).toEqual({ title, source: 'acp' });
      seedConversationTitle('canvas', 'queried', 'First prompt');
      query.mockResolvedValueOnce({
        titles: { queried: { title, source: 'acp' } },
      });
      await refreshConversationTitles('canvas', ['queried']);
      expect(getConversationTitle('canvas', 'queried')).toEqual({
        title,
        source: 'acp',
      });
      await refreshConversationTitles('canvas', ['thread', 'queried']);
      expect(current().source).toBe('generated');
      expect(getConversationTitle('canvas', 'queried').source).toBe(
        'generated',
      );
    },
  );

  it('accepts system-like manual cached, queried, and pending titles', async () => {
    query.mockResolvedValueOnce({
      titles: { thread: { title: systemLikeTitle, source: 'user' } },
    });
    await refreshConversationTitles('canvas', ['thread']);
    receiveAcpConversationTitle('canvas', 'thread', 'Valid ACP');
    await refreshConversationTitles('canvas', ['thread']);
    expect(current()).toEqual({ title: systemLikeTitle, source: 'user' });
    await renameConversationTitle('canvas', 'draft', systemLikeTitle, true);
    receiveAcpConversationTitle('canvas', 'draft', 'Valid ACP');
    expect(getConversationTitle('canvas', 'draft')).toEqual({
      title: systemLikeTitle,
      source: 'user',
    });
  });

  it('preserves pending manual intent during ACP events and a generated query upgrade', async () => {
    const result = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValueOnce(result.promise);
    const loading = refreshConversationTitles('canvas', ['thread']);
    receiveAcpConversationTitle('canvas', 'thread', 'ACP fallback');
    save.mockRejectedValue(new ApiError(404, {}, 'Not durable yet'));
    await renameConversationTitle('canvas', 'thread', 'Pending manual', true);
    receiveAcpConversationTitle('canvas', 'thread', 'Late ACP');
    result.resolve({
      titles: { thread: { title: 'Generated', source: 'generated' } },
    });
    await loading;
    expect(current()).toEqual({ title: 'Pending manual', source: 'user' });
    expect(useConversationTitleStore.getState().pending[key]).toBe(
      'Pending manual',
    );
    expect(useConversationTitleStore.getState().entries[key].value).toEqual({
      title: 'Generated',
      source: 'generated',
    });
  });

  it('rolls back a failed established rename and retries the attempted title explicitly', async () => {
    receiveAcpConversationTitle('canvas', 'thread', 'Original');
    save.mockRejectedValueOnce(new Error('Save failed'));
    await expect(
      renameConversationTitle('canvas', 'thread', 'New', false),
    ).rejects.toThrow('Save failed');
    expect(current()).toEqual({ title: 'Original', source: 'acp' });
    await retryConversationTitle('canvas', 'thread');
    expect(current()).toEqual({ title: 'New', source: 'user' });
    expect(save).toHaveBeenLastCalledWith('canvas', 'thread', { title: 'New' });
  });

  it('does not let a stale save failure roll back a later successful rename', async () => {
    const old = deferred<ConversationTitle>();
    save.mockReturnValueOnce(old.promise);
    const first = renameConversationTitle('canvas', 'thread', 'Old', false);
    const rejection = expect(first).rejects.toThrow('Old failed');
    await renameConversationTitle('canvas', 'thread', 'New', false);
    old.reject(new Error('Old failed'));
    await rejection;
    expect(current().title).toBe('New');
  });

  it('persists only pending pre-send user names and flushes after reload/durability', async () => {
    seedConversationTitle('canvas', 'thread', 'Prompt');
    await renameConversationTitle('canvas', 'thread', 'Draft title', true);
    expect(save).not.toHaveBeenCalled();
    const persisted = localStorage.getItem('huabu.conversationTitleDrafts')!;
    expect(JSON.parse(persisted).state).toEqual({
      pending: { [key]: 'Draft title' },
    });
    useConversationTitleStore.setState({ entries: {}, pending: {} });
    localStorage.setItem('huabu.conversationTitleDrafts', persisted);
    await useConversationTitleStore.persist.rehydrate();
    expect(current()).toEqual({ title: 'Draft title', source: 'user' });
    await refreshConversationTitles('canvas', ['thread']);
    expect(save).toHaveBeenCalledWith('canvas', 'thread', {
      title: 'Draft title',
    });
    expect(useConversationTitleStore.getState().pending).toEqual({});
    expect(
      JSON.parse(localStorage.getItem('huabu.conversationTitleDrafts')!).state,
    ).toEqual({ pending: {} });
  });

  it('retains a pre-send name across 404 creation races and visible failure, then retries', async () => {
    await renameConversationTitle('canvas', 'thread', 'Keep me', true);
    save.mockRejectedValueOnce(new ApiError(404, {}, 'Not durable'));
    await flushPendingConversationTitle('canvas', 'thread');
    expect(current().title).toBe('Keep me');
    expect(useConversationTitleStore.getState().pending[key]).toBe('Keep me');
    save.mockRejectedValueOnce(new Error('Offline'));
    await refreshConversationTitles('canvas', ['thread']);
    expect(useConversationTitleStore.getState().entries[key].error).toBe(
      'Offline',
    );
    await retryConversationTitle('canvas', 'thread');
    expect(useConversationTitleStore.getState().pending[key]).toBeUndefined();
    expect(current().title).toBe('Keep me');
  });

  it('serializes pending flushes and saves the newest edit made while a flush is in flight', async () => {
    await renameConversationTitle('canvas', 'thread', 'First', true);
    const firstSave = deferred<ConversationTitle>();
    save.mockReturnValueOnce(firstSave.promise);
    const first = flushPendingConversationTitle('canvas', 'thread');
    const duplicate = flushPendingConversationTitle('canvas', 'thread');
    await renameConversationTitle('canvas', 'thread', 'Latest', true);
    firstSave.resolve({ title: 'First', source: 'user' });
    await Promise.all([first, duplicate]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(current().title).toBe('Latest');
    expect(useConversationTitleStore.getState().pending[key]).toBeUndefined();
  });

  it('does not restore pending intent after successful node transfer during a flush', async () => {
    await renameConversationTitle('canvas', 'thread', 'Transferred', true);
    const result = deferred<ConversationTitle>();
    save.mockReturnValueOnce(result.promise);
    const flushing = flushPendingConversationTitle('canvas', 'thread');
    clearPendingConversationTitle('canvas', 'thread');
    result.resolve({ title: 'Transferred', source: 'user' });
    await flushing;
    expect(useConversationTitleStore.getState().pending).toEqual({});
  });

  it('trims and enforces the manual 120-character limit without making requests', async () => {
    await expect(
      renameConversationTitle('canvas', 'thread', ' ', false),
    ).rejects.toThrow();
    await expect(
      renameConversationTitle('canvas', 'thread', 'x'.repeat(121), true),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    await renameConversationTitle('canvas', 'thread', 'x'.repeat(120), false);
    expect(current().title).toHaveLength(120);
  });
});
