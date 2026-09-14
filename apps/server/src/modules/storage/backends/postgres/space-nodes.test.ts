// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { expect, it, vi } from 'vitest';

import {
  PostgresSpaceNodes,
  putPostgresNodeInTransaction,
} from './space-nodes.js';
import { unitContext } from './unit-test-support.js';
import { nodeRow, note } from '../sql/test-fixtures.js';
it('returns CAS conflicts before allocating a label or writing', async () => {
  const h = unitContext();
  h.get.mockResolvedValueOnce({ present: 1 }).mockResolvedValueOnce(nodeRow());
  expect(
    await putPostgresNodeInTransaction(h.database, 'workspace', 'space', {
      nodeId: 'node',
      record: note(),
      expectedRevision: null,
    }),
  ).toEqual({
    ok: false,
    reason: 'revision-conflict',
    currentRevision: 'revision',
  });
  expect(h.all).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
});
it('reports strict-label collisions without modifying either node', async () => {
  const h = unitContext();
  h.get
    .mockResolvedValueOnce({ present: 1 })
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(nodeRow('other'));
  expect(
    await putPostgresNodeInTransaction(h.database, 'workspace', 'space', {
      nodeId: 'node',
      record: note(),
      strictLabel: true,
    }),
  ).toMatchObject({
    ok: false,
    reason: 'label-conflict',
    conflictingNodeId: 'other',
  });
  expect(h.execute).not.toHaveBeenCalled();
});
it('deduplicates and bounds readMany SQL batches', async () => {
  const h = unitContext();
  h.get.mockResolvedValue({ present: 1 });
  h.all
    .mockResolvedValueOnce([nodeRow('n0')])
    .mockResolvedValueOnce([nodeRow('n500')]);
  const nodes = new PostgresSpaceNodes(h.context, 'workspace', 'space');
  const ids = Array.from({ length: 501 }, (_, i) => `n${i}`);
  expect([...(await nodes.readMany([...ids, ...ids])).keys()]).toEqual([
    'n0',
    'n500',
  ]);
  expect(h.all.mock.calls.map((call) => call.length - 2)).toEqual([500, 1]);
});
it('aborts stream delivery without fetching another page and propagates consumer errors', async () => {
  const h = unitContext();
  h.get.mockResolvedValue({ present: 1 });
  h.all.mockResolvedValue([nodeRow('a'), nodeRow('b')]);
  const nodes = new PostgresSpaceNodes(h.context, 'workspace', 'space');
  const abort = new AbortController();
  const delivered = vi.fn(() => abort.abort());
  expect((await nodes.stream(delivered, { signal: abort.signal })).size).toBe(
    1,
  );
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(h.all).toHaveBeenCalledTimes(1);
  await expect(
    nodes.stream(() => {
      throw new Error('consumer');
    }),
  ).rejects.toThrow('consumer');
});
it('checks retained handles even for empty or aborted reads', async () => {
  const h = unitContext();
  const nodes = new PostgresSpaceNodes(h.context, 'workspace', 'space');
  h.context.useWorkspace('other');
  await expect(nodes.readMany([])).rejects.toThrow(/inactive Workspace/);
  await expect(
    nodes.stream(() => {}, { signal: AbortSignal.abort() }),
  ).rejects.toThrow(/inactive Workspace/);
  expect(h.get).not.toHaveBeenCalled();
});
