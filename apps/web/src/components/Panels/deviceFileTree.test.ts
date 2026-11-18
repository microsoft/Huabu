// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it, vi } from 'vitest';

import { buildFileTreeRows, DeviceFileTree } from './deviceFileTree';

import type { FileListResult } from '@huabu/shared';

type Call = {
  path: string;
  cursor?: string;
  signal: AbortSignal;
  resolve: (entries: string[], nextCursor?: string) => void;
  reject: (failure: Error) => void;
};

function harness() {
  const calls: Call[] = [];
  const list = vi.fn(
    (
      _agentletId: string,
      args: { path: string; cursor?: string },
      signal?: AbortSignal,
    ) =>
      new Promise<FileListResult>((done, fail) => {
        if (!signal) throw new Error('Every listing must be cancellable');
        signal.addEventListener('abort', () =>
          fail(new DOMException('Aborted', 'AbortError')),
        );
        calls.push({
          path: args.path,
          cursor: args.cursor,
          signal,
          reject: fail,
          resolve: (names, nextCursor) =>
            done({
              ...(nextCursor ? { nextCursor } : {}),
              path: args.path,
              parentPath: '/',
              entries: names.map((name) => ({
                name,
                path: `${args.path === '/' ? '' : args.path}/${name}`,
                kind: 'directory' as const,
              })),
            }),
        });
      }),
  );
  const tree = new DeviceFileTree(list as never);
  const pending = () => calls.filter((call) => !call.signal.aborted);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { tree, calls, pending, settle };
}

const names = (tree: DeviceFileTree) =>
  buildFileTreeRows(tree.getSnapshot()).map((row) =>
    'entry' in row ? row.entry.path : `more:${row.more}`,
  );

it('never has more than four listings in flight, however many folders are open', async () => {
  const { tree, calls, settle } = harness();
  tree.open('device', '/', false);
  const folders = Array.from({ length: 10 }, (_, index) => `d${index}`);
  calls[0]?.resolve(folders);
  await settle();
  for (const folder of folders) tree.toggle(`/${folder}`, 0);
  await settle();
  expect(calls).toHaveLength(5);
  expect(tree.getSnapshot().loading.size).toBe(10);

  // Each finished listing frees exactly one slot.
  calls[1]?.resolve([]);
  await settle();
  expect(calls).toHaveLength(6);
  for (let index = 2; index < 11; index++) {
    calls[index]?.resolve([]);
    await settle();
  }
  expect(tree.getSnapshot().expanded.size).toBe(10);
  expect(tree.getSnapshot().loading.size).toBe(0);

  // Refresh re-lists the root and all ten folders, still four at a time.
  tree.refresh();
  await settle();
  expect(calls.length - 11).toBe(4);
  for (let index = 11; index < 22; index++) {
    calls[index]?.resolve(index === 11 ? folders : []);
    await settle();
  }
  expect(tree.getSnapshot().expanded.size).toBe(10);
  expect(tree.getSnapshot().error).toBeNull();
});

it('cancels folder listings when the device changes and ignores their replies', async () => {
  const { tree, calls, settle } = harness();
  tree.open('device', '/', false);
  calls[0]?.resolve(['a']);
  await settle();
  tree.toggle('/a', 0);
  await settle();
  const stale = calls[1];
  tree.open('other', '/', false);
  expect(stale?.signal.aborted).toBe(true);
  expect(tree.getSnapshot().root).toBeNull();
  expect(tree.getSnapshot().loading.size).toBe(0);
  calls[2]?.resolve(['b']);
  await settle();
  expect(names(tree)).toEqual(['/b']);
  expect(tree.getSnapshot().error).toBeNull();
});

it('keeps the listing on screen while navigating and reports which directory failed', async () => {
  const { tree, calls, settle } = harness();
  tree.open('device', '/', false);
  calls[0]?.resolve(['a']);
  await settle();
  tree.open('device', '/gone', false);
  expect(names(tree)).toEqual(['/a']);
  calls[1]?.reject(new Error('ENOENT'));
  await settle();
  expect(tree.getSnapshot()).toMatchObject({
    root: null,
    reloading: false,
    error: { kind: 'root', path: '/gone', message: 'ENOENT' },
  });
});

it('closes folders that disappear on refresh and keeps the rest open', async () => {
  const { tree, calls, settle } = harness();
  tree.open('device', '/', false);
  calls[0]?.resolve(['a', 'b']);
  await settle();
  tree.toggle('/a', 0);
  tree.toggle('/b', 0);
  await settle();
  calls[1]?.resolve(['x']);
  calls[2]?.resolve(['y']);
  await settle();
  tree.refresh();
  await settle();
  calls[3]?.resolve(['a']);
  calls[4]?.resolve(['x2']);
  calls[5]?.reject(new Error('ENOENT'));
  await settle();
  expect(names(tree)).toEqual(['/a', '/a/x2']);
  expect([...tree.getSnapshot().expanded]).toEqual(['/a']);
});

it('lists only the new directory when navigating, and every open folder on refresh', async () => {
  const { tree, calls, settle } = harness();
  tree.open('device', '/root', false);
  calls[0]?.resolve(['a', 'b']);
  await settle();
  tree.toggle('/root/a', 0);
  tree.toggle('/root/b', 0);
  await settle();
  calls[1]?.resolve(['x']);
  calls[2]?.resolve(['y']);
  await settle();

  // Going up: only the parent is new. The directory just left and the two
  // folders open inside it keep the listings they already have.
  tree.keepOpen('/root');
  tree.open('device', '/', false);
  await settle();
  expect(calls.slice(3).map((call) => call.path)).toEqual(['/']);
  calls[3]?.resolve(['root']);
  await settle();
  expect(names(tree)).toEqual([
    '/root',
    '/root/a',
    '/root/a/x',
    '/root/b',
    '/root/b/y',
  ]);

  tree.refresh();
  await settle();
  expect(
    calls
      .slice(4)
      .map((call) => call.path)
      .sort(),
  ).toEqual(['/', '/root', '/root/a', '/root/b']);
});

it('follows the latest click: a listing never reopens a folder closed meanwhile', async () => {
  const { tree, calls, settle } = harness();
  tree.open('device', '/', false);
  calls[0]?.resolve(['a', 'b']);
  await settle();

  // Opened and closed again before its first listing arrives.
  tree.toggle('/a', 0);
  expect(tree.getSnapshot().expanded.has('/a')).toBe(true);
  tree.toggle('/a', 0);
  await settle();
  calls[1]?.resolve(['x']);
  await settle();
  expect(tree.getSnapshot().expanded.has('/a')).toBe(false);
  expect(names(tree)).toEqual(['/a', '/b']);

  // The listing was kept, so reopening needs no second request.
  tree.toggle('/a', 0);
  expect(names(tree)).toEqual(['/a', '/a/x', '/b']);
  expect(calls).toHaveLength(2);

  // A folder that cannot be listed closes again.
  tree.toggle('/b', 0);
  await settle();
  calls[2]?.reject(new Error('EACCES'));
  await settle();
  expect(tree.getSnapshot().expanded.has('/b')).toBe(false);
  expect(tree.getSnapshot().error).toMatchObject({ kind: 'folder' });
});

it('drops a next page that was requested before a refresh replaced the listing', async () => {
  const { tree, calls, settle } = harness();
  tree.open('device', '/', false);
  calls[0]?.resolve(['a1', 'a2'], 'page-2');
  await settle();
  tree.loadMore('/');
  await settle();
  expect(calls[1]?.cursor).toBe('page-2');
  calls[1]?.resolve(['b1'], 'page-3');
  await settle();
  expect(names(tree)).toEqual(['/a1', '/a2', '/b1', 'more:/']);

  // Page three is on its way when the listing is refreshed.
  tree.loadMore('/');
  await settle();
  expect(calls[2]?.cursor).toBe('page-3');
  tree.refresh();
  await settle();
  calls[3]?.resolve(['a1', 'a2'], 'page-2');
  await settle();
  calls[2]?.resolve(['c1']);
  await settle();

  // The stale page is not appended, and the rest can still be loaded.
  expect(names(tree)).toEqual(['/a1', '/a2', 'more:/']);
  expect(tree.getSnapshot().loading.size).toBe(0);
  tree.loadMore('/');
  await settle();
  expect(calls[4]?.cursor).toBe('page-2');
});
