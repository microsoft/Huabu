// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { afterEach, expect, it } from 'vitest';

import { AzureBlobStore } from './blob-store.js';
import { openAzureTestStore } from './test-support.js';

let harness: Awaited<ReturnType<typeof openAzureTestStore>> | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});
async function open() {
  harness = await openAzureTestStore();
  await harness.store.init();
  return harness;
}

it('keeps zero-byte and multi-block payloads intact, including inclusive ranges', async () => {
  const h = await open();
  const scope = h.store.space(h.canvasId).artifacts;
  await scope.put('empty', Buffer.alloc(0));
  expect(await scope.read('empty')).toEqual(Buffer.alloc(0));
  const data = Buffer.alloc(10 * 1024 * 1024 + 7, 'x');
  data.fill('y', 4 * 1024 * 1024);
  await scope.put(
    'large.bin',
    Readable.from([data.subarray(0, 33), data.subarray(33)]),
  );
  // Native byte equality avoids enumerating millions of Buffer properties.
  expect((await scope.read('large.bin'))?.equals(data)).toBe(true);
  const range = await scope.open('large.bin', {
    start: 4 * 1024 * 1024 - 3,
    end: 4 * 1024 * 1024 + 3,
  });
  expect(range?.info.size).toBe(data.length);
  const chunks = [];
  for await (const chunk of range!.body) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(Buffer.from('xxxyyyy'));
});

it('keeps committed bytes after a failure beyond the first staged block and cleans failed uploads on deletion', async () => {
  const h = await open();
  const scope = h.store.space(h.canvasId).artifacts;
  await scope.put('replace', Buffer.from('before'));
  async function* broken() {
    yield Buffer.alloc(5 * 1024 * 1024);
    throw new Error('source failed');
  }
  await expect(scope.put('replace', Readable.from(broken()))).rejects.toThrow(
    'source failed',
  );
  await expect(scope.put('new', Readable.from(broken()))).rejects.toThrow(
    'source failed',
  );
  expect(await scope.read('replace')).toEqual(Buffer.from('before'));
  expect(await scope.read('new')).toBeNull();
  expect((await scope.list()).map((blob) => blob.name)).toEqual(['replace']);
  await scope.deleteAll();
  const remaining = [];
  for await (const blob of h.container.listBlobsFlat({
    includeUncommitedBlobs: true,
  }))
    remaining.push(blob.name);
  expect(remaining).toEqual([]);
});

it('isolates Workspace identities and rejects retained scopes after activation', async () => {
  const h = await open();
  const first = h.store.space('same').artifacts;
  await first.put('same', Buffer.from('A'));
  h.workspace.id = 'second-workspace';
  await expect(first.read('same')).rejects.toThrow(/inactive Workspace/);
  const second = h.store.space('same').artifacts;
  expect(await second.read('same')).toBeNull();
  await second.put('same', Buffer.from('B'));
  await second.deleteAll();
  h.workspace.id = 'test-workspace';
  expect(await h.store.space('same').artifacts.read('same')).toEqual(
    Buffer.from('A'),
  );
});

it('materializes a read-only temporary file and removes it on release', async () => {
  const h = await open();
  const scope = h.store.space(h.canvasId).artifacts;
  await scope.put('file.pdf', Buffer.from('document'));
  const lease = await scope.materialize('file.pdf');
  const filename = lease!.path;
  expect(await readFile(filename, 'utf8')).toBe('document');
  if (process.platform !== 'win32')
    expect((await stat(filename)).mode & 0o222).toBe(0);
  await lease!.release();
  await lease!.release();
  await expect(stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('serializes staged replacements across separately resolved scopes and recovers after a failed writer', async () => {
  const h = await open();
  const firstScope = h.store.space(h.canvasId).artifacts;
  const secondScope = h.store.space(h.canvasId).artifacts;
  let markStaged: () => void = () => {};
  let releaseFirst: () => void = () => {};
  const staged = new Promise<void>((resolve) => {
    markStaged = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondConsumed = false;
  async function* firstBody() {
    yield Buffer.alloc(5 * 1024 * 1024, 'a');
    markStaged();
    await release;
    throw new Error('first source failed');
  }
  async function* secondBody() {
    secondConsumed = true;
    yield Buffer.from('second writer');
  }
  const first = expect(
    firstScope.put('same-key', Readable.from(firstBody())),
  ).rejects.toThrow('first source failed');
  await staged;
  const second = secondScope.put('same-key', Readable.from(secondBody()));
  await Promise.resolve();
  await Promise.resolve();
  expect(secondConsumed).toBe(false);
  releaseFirst();
  await first;
  await second;
  expect(await firstScope.read('same-key')).toEqual(
    Buffer.from('second writer'),
  );
});

it('reopens committed blobs and keeps configured prefixes isolated in one container', async () => {
  const h = await open();
  const scope = h.store.space('space').artifacts;
  await scope.put('你好.txt', Buffer.from('persistent bytes'));
  await h.store.close();
  const reopened = new AzureBlobStore(h.container, () => h.workspace.id);
  const isolated = new AzureBlobStore(
    h.container,
    () => h.workspace.id,
    'other-prefix',
  );
  try {
    await reopened.init();
    await isolated.init();
    expect(await reopened.space('space').artifacts.read('你好.txt')).toEqual(
      Buffer.from('persistent bytes'),
    );
    expect(await isolated.space('space').artifacts.read('你好.txt')).toBeNull();
    await isolated
      .space('space')
      .artifacts.put('你好.txt', Buffer.from('other bytes'));
    await isolated.space('space').artifacts.deleteAll();
    expect(await reopened.space('space').artifacts.read('你好.txt')).toEqual(
      Buffer.from('persistent bytes'),
    );
    expect(await h.container.exists()).toBe(true);
  } finally {
    await reopened.close();
    await isolated.close();
  }
});

it('handles hasMany batches and deletes snapshot-bearing blobs without touching other areas', async () => {
  const h = await open();
  const areas = h.store.space('space');
  const names = Array.from({ length: 35 }, (_, i) => `file-${i}`);
  await Promise.all(
    names.map((name) => areas.artifacts.put(name, Buffer.from(name))),
  );
  await areas.uploads.put('file-0', Buffer.from('upload'));
  expect(
    await areas.artifacts.hasMany([...names, ...names, 'missing']),
  ).toEqual(new Set(names));
  const client = h.container.getBlobClient(
    `huabu/${h.workspace.id}/space/artifacts/file-0`,
  );
  await client.createSnapshot();
  await areas.artifacts.deleteAll();
  expect(await areas.artifacts.list()).toEqual([]);
  expect(await areas.uploads.read('file-0')).toEqual(Buffer.from('upload'));
});
