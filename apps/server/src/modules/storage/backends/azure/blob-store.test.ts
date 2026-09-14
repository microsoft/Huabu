// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Readable } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

import { AzureBlobStore } from './blob-store.js';

import type { ContainerClient } from '@azure/storage-blob';
function harness() {
  const blob = {
    getProperties: vi.fn(),
    download: vi.fn(),
    stageBlock: vi.fn(),
    commitBlockList: vi.fn().mockResolvedValue({ lastModified: new Date(1) }),
    deleteIfExists: vi.fn(),
  };
  const container = {
    url: 'https://example.test/container?sig=private',
    getProperties: vi.fn().mockResolvedValue({}),
    getBlobClient: vi.fn(() => blob),
    getBlockBlobClient: vi.fn(() => blob),
    listBlobsFlat: vi.fn(),
    delete: vi.fn(),
  };
  const workspace = { id: 'workspace' };
  const store = new AzureBlobStore(
    container as unknown as ContainerClient,
    () => workspace.id,
  );
  return { store, blob, container, workspace };
}
afterEach(() => vi.unstubAllEnvs());
it('requires configuration, validates prefixes, and does not own the container lifecycle', async () => {
  vi.stubEnv('HUABU_AZURE_STORAGE_CONNECTION_STRING', '');
  vi.stubEnv('HUABU_AZURE_BLOB_CONTAINER', '');
  expect(() => AzureBlobStore.fromEnvironment()).toThrow(/require/);
  const h = harness();
  expect(
    () => new AzureBlobStore(h.container as never, () => 'w', '../bad'),
  ).toThrow(/prefix/);
  expect((await h.store.health()).ok).toBe(false);
  await h.store.init();
  expect((await h.store.health()).ok).toBe(true);
  await h.store.close();
  await h.store.close();
  await expect(h.store.init()).rejects.toThrow(/closed/);
  expect(h.container.delete).not.toHaveBeenCalled();
});
it.each([401, 403, 409, 500])(
  'propagates Azure %i errors instead of treating them as absence',
  async (statusCode) => {
    const h = harness();
    await h.store.init();
    const error = Object.assign(new Error('service failure'), { statusCode });
    h.blob.getProperties.mockRejectedValue(error);
    h.blob.download.mockRejectedValue(error);
    const scope = h.store.space('space').artifacts;
    await expect(scope.head('file')).rejects.toBe(error);
    await expect(scope.open('file')).rejects.toBe(error);
  },
);
it('maps only 404 to missing and validates ranges before requesting Azure', async () => {
  const h = harness();
  await h.store.init();
  h.blob.getProperties.mockRejectedValue({ statusCode: 404 });
  h.blob.download.mockRejectedValue({ statusCode: 404 });
  const scope = h.store.space('space').artifacts;
  expect(await scope.head('file')).toBeNull();
  expect(await scope.read('file')).toBeNull();
  h.blob.download.mockClear();
  for (const range of [
    { start: -1 },
    { start: 1.5 },
    { start: 2, end: 1 },
    { start: 0, end: Infinity },
  ])
    await expect(scope.open('file', range)).rejects.toThrow(RangeError);
  expect(h.blob.download).not.toHaveBeenCalled();
});
it('derives metadata and an inclusive range from the same download response', async () => {
  const h = harness();
  await h.store.init();
  h.blob.download.mockResolvedValue({
    contentRange: 'bytes 2-4/10',
    contentLength: 3,
    lastModified: new Date(5),
    readableStreamBody: Readable.from(['abc']),
  });
  const result = await h.store
    .space('space')
    .artifacts.open('file', { start: 2, end: 4 });
  expect(h.blob.download).toHaveBeenCalledWith(2, 3);
  expect(result?.info).toEqual({ name: 'file', size: 10, updatedAt: 5 });
  expect(h.blob.getProperties).not.toHaveBeenCalled();
  result?.body.destroy();
});
it('destroys failed upload streams and never publishes after staging fails', async () => {
  const h = harness();
  await h.store.init();
  const failure = new Error('stage failed');
  h.blob.stageBlock.mockRejectedValue(failure);
  const stream = Readable.from([Buffer.alloc(5 * 1024 * 1024)]);
  await expect(
    h.store.space('space').artifacts.put('file', stream),
  ).rejects.toBe(failure);
  expect(stream.destroyed).toBe(true);
  expect(h.blob.commitBlockList).not.toHaveBeenCalled();
});
it('propagates commit errors and releases the upload queue for the next writer', async () => {
  const h = harness();
  await h.store.init();
  const scope = h.store.space('space').artifacts;
  h.blob.commitBlockList.mockRejectedValueOnce(new Error('commit failed'));
  await expect(scope.put('file', Buffer.from('first'))).rejects.toThrow(
    'commit failed',
  );
  expect(await scope.put('file', Buffer.from('second'))).toMatchObject({
    name: 'file',
    size: 6,
  });
});
it('rejects unsafe names and inactive scopes before contacting Azure', async () => {
  const h = harness();
  await h.store.init();
  const space = h.store.space('space');
  await expect(space.artifacts.put('..', Buffer.from('bad'))).rejects.toThrow();
  await expect(
    space.guide.put('unexpected', Buffer.from('bad')),
  ).rejects.toThrow();
  h.workspace.id = 'other';
  await expect(space.artifacts.hasMany([])).rejects.toThrow(
    /inactive Workspace/,
  );
  expect(h.container.getBlockBlobClient).not.toHaveBeenCalled();
});
it('scopes listing and deletion, excluding nested or foreign guide members', async () => {
  const h = harness();
  await h.store.init();
  h.container.listBlobsFlat.mockImplementation(async function* () {
    for (const name of [
      'huabu/workspace/space/guide/skill.md',
      'huabu/workspace/space/guide/unexpected',
      'huabu/workspace/space/guide/nested/file',
    ])
      yield { name, properties: {} };
  });
  const scope = h.store.space('space').guide;
  expect((await scope.list()).map((item) => item.name)).toEqual(['skill.md']);
  await scope.deleteAll();
  expect(h.container.getBlobClient).toHaveBeenCalledTimes(1);
  expect(h.blob.deleteIfExists).toHaveBeenCalledWith({
    deleteSnapshots: 'include',
  });
});
