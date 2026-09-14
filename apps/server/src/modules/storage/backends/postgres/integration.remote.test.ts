// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it } from 'vitest';

import { PostgresStoreContext } from './database.js';
import { PostgresStructuredStore } from './structured-store.js';
import { openPostgresTestStore } from './test-support.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function open() {
  const h = await openPostgresTestStore();
  cleanup.push(h.cleanup);
  await h.store.spaces().create({ canvasId: 'space', title: 'Test' });
  return h;
}

it('serializes CAS and label allocation across independent connections, then reopens', async () => {
  const h = await open();
  const other = new PostgresStoreContext(h.config);
  cleanup.push(() => other.close());
  await other.init();
  other.useWorkspace(h.workspaceId);
  const second = new PostgresStructuredStore(other);
  const nodes = [h.store.space('space').nodes, second.space('space').nodes];
  const put = (
    index: number,
    nodeId: string,
    expectedRevision?: string | null,
  ) =>
    nodes[index % 2].put({
      nodeId,
      record: { nodeId, type: 'note', label: 'Shared', content: String(index) },
      expectedRevision,
    });
  const created = await Promise.all(
    Array.from({ length: 12 }, (_, i) => put(i, `node-${i}`)),
  );
  expect(created.every((result) => result.ok)).toBe(true);
  const listed = await nodes[0].list();
  expect(
    new Set([...listed.values()].map((value) => value.record.label)).size,
  ).toBe(12);
  const initial = await nodes[0].read('node-0');
  if (!initial) throw new Error('Missing node');
  const raced = await Promise.all([
    put(0, 'node-0', initial.revision),
    put(1, 'node-0', initial.revision),
  ]);
  expect(raced.filter((result) => result.ok)).toHaveLength(1);
  expect(raced.filter((result) => !result.ok)).toMatchObject([
    { reason: 'revision-conflict' },
  ]);
  await other.close();
  const reopened = new PostgresStoreContext(h.config);
  cleanup.push(() => reopened.close());
  await reopened.init();
  reopened.useWorkspace(h.workspaceId);
  expect(
    await new PostgresStructuredStore(reopened).space('space').nodes.list(),
  ).toEqual(await nodes[0].list());
});

it('rejects future schemas without modifying them', async () => {
  const h = await open();
  await h.context
    .connection()
    .query('UPDATE huabu_schema_version SET version = 999');
  const future = new PostgresStoreContext(h.config);
  cleanup.push(() => future.close());
  await expect(future.init()).rejects.toThrow('newer than supported');
  expect(
    (
      await h.context
        .connection()
        .query('SELECT version FROM huabu_schema_version')
    ).rows,
  ).toEqual([{ version: 999 }]);
  expect(await h.store.space('space').read()).not.toBeNull();
});

it('keeps every Space part isolated by Workspace and rejects retained handles', async () => {
  const h = await open();
  const retained = h.store.space('space');
  await retained.nodes.put({
    nodeId: 'note',
    record: {
      nodeId: 'note',
      type: 'note',
      label: 'Private',
      content: 'private',
    },
  });
  const other = await new PostgresWorkspaceRepository(h.context).create(
    'Other',
  );
  h.context.useWorkspace(other.workspaceId);
  await expect(retained.nodes.read('note')).rejects.toThrow(
    'inactive Workspace',
  );
  const absent = h.store.space('space');
  expect(await absent.read()).toBeNull();
  expect(await absent.nodes.read('note')).toBeNull();
  expect(await absent.nodes.list()).toEqual(new Map());
  expect(await absent.nodes.readMany(['note'])).toEqual(new Map());
  expect(await absent.events.read()).toEqual([]);
  expect(await absent.changes.read('thread')).toEqual([]);
  expect(await absent.tasks.read()).toEqual({
    version: 1,
    tasks: [],
    runs: [],
  });
  expect(await absent.extension('test.private')).toBeNull();
});
