// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  invalidateConversationTitle,
  needsConversationTitleRefresh,
  refreshConversationTitles,
  renameConversationTitle,
  retryConversationTitle,
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
const settleRequests = new Set<() => void>();

async function loadTitle(
  title: string,
  source: ConversationTitle['source'] = 'fallback',
) {
  query.mockResolvedValueOnce({ titles: { thread: { title, source } } });
  await refreshConversationTitles('canvas', ['thread']);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A failed race assertion must not leave the store's module-level dedupe locked.
  void promise.catch(() => {});
  settleRequests.add(() => reject(new Error('Test cleanup')));
  return { promise, resolve, reject };
}

afterEach(async () => {
  query.mockResolvedValue({ titles: {} });
  for (const settle of settleRequests) settle();
  settleRequests.clear();
  for (let index = 0; index < 10; index++) await Promise.resolve();
});

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
  it('remains untitled until the backend supplies a title', async () => {
    expect(current()).toEqual({ title: null, source: null });
    await loadTitle('Backend fallback');
    expect(current()).toEqual({
      title: 'Backend fallback',
      source: 'fallback',
    });
  });

  it.each<ConversationTitle>([
    { title: 'Backend generated', source: 'generated' },
    { title: 'Backend ACP', source: 'acp' },
    { title: 'Backend fallback', source: 'fallback' },
    { title: null, source: null },
    { title: '', source: 'acp' },
    { title: '  Topic\tname  ', source: 'acp' },
    { title: 'Multiple\nlines', source: 'acp' },
    { title: 'x'.repeat(121), source: 'acp' },
  ])(
    'adopts the exact backend projection without local ranking or filtering: %j',
    async (value) => {
      await loadTitle('Previous server manual title', 'user');
      query.mockResolvedValueOnce({ titles: { thread: value } });
      await refreshConversationTitles('canvas', ['thread']);
      expect(current()).toEqual(value);
      expect(useConversationTitleStore.getState().entries[key].value).toEqual(
        value,
      );
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

  it('fences an invalidated in-flight read and fetches the latest backend value after it settles', async () => {
    await loadTitle('Displayed');
    const result = deferred<QueryConversationTitlesResponse>();
    const latest = deferred<QueryConversationTitlesResponse>();
    query.mockClear();
    query
      .mockReturnValueOnce(result.promise)
      .mockReturnValueOnce(latest.promise);
    const loading = refreshConversationTitles('canvas', ['thread']);
    const revision = useConversationTitleStore.getState().entries[key].revision;
    invalidateConversationTitle('canvas', 'thread');
    expect(
      useConversationTitleStore.getState().entries[key].revision,
    ).toBeGreaterThan(revision);
    expect(query).toHaveBeenCalledTimes(1);
    result.resolve({
      titles: { thread: { title: 'Obsolete', source: 'generated' } },
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(current()).toEqual({ title: 'Displayed', source: 'fallback' });
    latest.resolve({
      titles: { thread: { title: 'Latest backend', source: 'fallback' } },
    });
    await loading;
    await vi.waitFor(() =>
      expect(current()).toEqual({
        title: 'Latest backend',
        source: 'fallback',
      }),
    );
    expect(query).toHaveBeenLastCalledWith({
      canvasId: 'canvas',
      threadIds: ['thread'],
    });
  });

  it('coalesces a burst of invalidations into one followup while ordinary refreshes only deduplicate', async () => {
    const result = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValueOnce(result.promise);
    const loading = refreshConversationTitles('canvas', ['thread']);
    const duplicate = refreshConversationTitles('canvas', ['thread']);
    for (let index = 0; index < 10; index++)
      invalidateConversationTitle('canvas', 'thread');
    expect(query).toHaveBeenCalledTimes(1);
    result.resolve({
      titles: { thread: { title: 'Obsolete', source: 'user' } },
    });
    await Promise.all([loading, duplicate]);
    await vi.waitFor(() => expect(current().title).toBe('Title thread'));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('retries an untitled realized thread without polling an untouched empty tab', async () => {
    expect(needsConversationTitleRefresh('canvas', 'thread')).toBe(false);
    query.mockResolvedValueOnce({
      titles: { thread: { title: null, source: null } },
    });
    invalidateConversationTitle('canvas', 'thread');
    await refreshConversationTitles('canvas', ['thread']);
    expect(current()).toEqual({ title: null, source: null });
    expect(needsConversationTitleRefresh('canvas', 'thread')).toBe(true);
    expect(needsConversationTitleRefresh('canvas', 'untouched')).toBe(false);
  });

  it('does not invalidate a manual save when ACP metadata triggers a refetch', async () => {
    await loadTitle('Original');
    const saving = deferred<ConversationTitle>();
    save.mockReturnValueOnce(saving.promise);
    const rename = renameConversationTitle('canvas', 'thread', 'Manual', false);
    const revision = useConversationTitleStore.getState().entries[key].revision;
    query.mockResolvedValueOnce({
      titles: { thread: { title: 'Old backend', source: 'acp' } },
    });
    invalidateConversationTitle('canvas', 'thread');
    await refreshConversationTitles('canvas', ['thread']);
    expect(useConversationTitleStore.getState().entries[key].revision).toBe(
      revision,
    );
    expect(current().title).toBe('Manual');
    saving.resolve({ title: 'Saved manual title', source: 'user' });
    await rename;
    expect(current()).toEqual({ title: 'Saved manual title', source: 'user' });
    expect(useConversationTitleStore.getState().entries[key].renaming).toBe(
      false,
    );
  });

  it('protects a manual rename against an older server response', async () => {
    const result = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValueOnce(result.promise);
    const loading = refreshConversationTitles('canvas', ['thread']);
    await renameConversationTitle('canvas', 'thread', ' My title ', false);
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
    await loadTitle('Original');
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
    await loadTitle('First prompt');
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
    await loadTitle('Original');
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

  it('accepts system-like manual cached, queried, and pending titles', async () => {
    query.mockResolvedValueOnce({
      titles: { thread: { title: systemLikeTitle, source: 'user' } },
    });
    await refreshConversationTitles('canvas', ['thread']);
    expect(current()).toEqual({ title: systemLikeTitle, source: 'user' });
    await renameConversationTitle('canvas', 'draft', systemLikeTitle, true);
    expect(getConversationTitle('canvas', 'draft')).toEqual({
      title: systemLikeTitle,
      source: 'user',
    });
  });

  it('preserves pending manual intent through invalidation and backend refreshes', async () => {
    const result = deferred<QueryConversationTitlesResponse>();
    query.mockReturnValueOnce(result.promise);
    const loading = refreshConversationTitles('canvas', ['thread']);
    save.mockRejectedValue(new ApiError(404, {}, 'Not durable yet'));
    await renameConversationTitle('canvas', 'thread', 'Pending manual', true);
    invalidateConversationTitle('canvas', 'thread');
    invalidateConversationTitle('canvas', 'thread');
    result.resolve({
      titles: { thread: { title: 'Generated', source: 'generated' } },
    });
    await loading;
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    await refreshConversationTitles('canvas', ['thread']);
    expect(current()).toEqual({ title: 'Pending manual', source: 'user' });
    expect(useConversationTitleStore.getState().pending[key]).toBe(
      'Pending manual',
    );
    expect(useConversationTitleStore.getState().entries[key].value).toEqual({
      title: 'Title thread',
      source: 'generated',
    });
  });

  it('rolls back a failed established rename and retries the attempted title explicitly', async () => {
    await loadTitle('Original', 'acp');
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
