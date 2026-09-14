// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it } from 'vitest';

import { PostgresStoreContext } from './database.js';
import { PostgresStructuredStore } from './structured-store.js';
import { openPostgresTestStore } from './test-support.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';
import {
  appendSubstrateLog,
  readSubstrateDocument,
  writeSubstrateDocument,
} from '../../../agent/substrate-store.js';
import { event, note, task, run } from '../sql/test-fixtures.js';

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

it('round trips more than one readMany and stream batch, including cancellation', async () => {
  const h = await open();
  const nodes = h.store.space('space').nodes;
  // Keep all normal adapter writes inside one real transaction to make this fixture fast.
  const { putPostgresNodeInTransaction } = await import('./space-nodes.js');
  await h.context.transaction(async (db) => {
    for (let i = 0; i < 513; i++) {
      const nodeId = `n${String(i).padStart(4, '0')}`;
      await putPostgresNodeInTransaction(db, h.workspaceId, 'space', {
        nodeId,
        record: note(nodeId),
      });
    }
  });
  const all = await nodes.list();
  const ids = [...all.keys()];
  expect(await nodes.readMany([...ids, ...ids, 'missing'])).toEqual(all);
  const delivered: string[] = [];
  expect(
    await nodes.stream((snapshot) => delivered.push(snapshot.record.nodeId)),
  ).toEqual(all);
  expect(delivered).toEqual(ids);
  const abort = new AbortController();
  let count = 0;
  const partial = await nodes.stream(
    () => {
      if (++count === 129) abort.abort();
    },
    { signal: abort.signal },
  );
  expect(partial.size).toBe(129);
  expect(await nodes.readMany([])).toEqual(new Map());
});

it('rolls back real SQL failures and preserves the transaction queue for the next writer', async () => {
  const h = await open();
  const db = h.context.connection();
  await expect(
    h.context.transaction(async (executor) => {
      await executor.run(
        'UPDATE spaces SET title = ? WHERE canvas_id = ?',
        'uncommitted',
        'space',
      );
      await executor.run(
        'INSERT INTO nodes VALUES (?, ?, ?, ?, ?)',
        'missing',
        'n',
        '{}',
        'r',
        'n',
      );
    }),
  ).rejects.toMatchObject({ code: '23503' });
  expect((await h.store.space('space').read())?.title).toBe('Test');
  await h.store
    .space('space')
    .nodes.put({ nodeId: 'healthy', record: note('healthy') });
  expect((await db.query('SELECT node_id FROM nodes')).rows).toEqual([
    { node_id: 'healthy' },
  ]);
});

it('persists extension documents and concurrent log appends across independent pools', async () => {
  const h = await open();
  const peer = new PostgresStoreContext(h.config);
  cleanup.push(() => peer.close());
  await peer.init();
  peer.useWorkspace(h.workspaceId);
  const a = await h.store.space('space').extension('agent.documents');
  const b = await new PostgresStructuredStore(peer)
    .space('space')
    .extension('agent.documents');
  const other = await h.store.space('space').extension('agent.other');
  if (!a || !b || !other) throw new Error('Expected substrates');
  // Simultaneous first use also races lazy table creation across independent pools.
  await Promise.all([
    writeSubstrateDocument(a, 'state', { count: 1 }),
    writeSubstrateDocument(b, 'second', { count: 2 }),
  ]);
  expect(await readSubstrateDocument(b, 'state')).toEqual({ count: 1 });
  expect(await readSubstrateDocument(other, 'state')).toBeNull();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      appendSubstrateLog(i % 2 ? a : b, 'debug', '.log', `${i},`),
    ),
  );
  const body = (
    await h.context
      .connection()
      .query(
        'SELECT body FROM extension_documents WHERE extension_id = $1 AND name = $2',
        [a.kind === 'postgres' ? a.extensionId : -1, 'debug.log'],
      )
  ).rows[0].body as string;
  expect(body.split(',').filter(Boolean).sort()).toEqual(
    Array.from({ length: 20 }, (_, i) => String(i)).sort(),
  );
});

it('deletes every owned row while preserving a neighboring space and its extension', async () => {
  const h = await open();
  const space = h.store.space('space');
  await h.store.spaces().create({ canvasId: 'neighbor', title: 'Neighbor' });
  const neighbor = h.store.space('neighbor');
  for (const handle of [space, neighbor]) {
    await handle.nodes.put({ nodeId: 'node', record: note() });
    await handle.events.append([event()]);
    await handle.changes.append('thread', []);
    await handle.tasks.create({ ...task(), canvasId: handle.canvasId });
    const substrate = await handle.extension('agent.documents');
    if (!substrate) throw new Error('Expected substrate');
    await writeSubstrateDocument(substrate, 'state', {
      private: handle.canvasId,
    });
    const record = (await handle.read())!;
    await handle.write({
      expectedVersion: 0,
      nextRecord: { ...record, version: 1 },
      nodeMutations: [],
      delta: {
        version: 1,
        deltas: [],
        commands: [],
        ts: 1,
        originator: { source: 'system' },
      },
    });
  }
  await space.tasks.runs.create(run());
  const deletion = await h.store.spaces().beginDelete({ canvasId: 'space' });
  if (!deletion.ok) throw new Error('Expected deletion session');
  expect(await deletion.session.finish()).toEqual({
    ok: true,
    reason: 'deleted',
  });
  for (const table of [
    'nodes',
    'events',
    'changes',
    'tasks',
    'space_extensions',
    'delta_log',
  ]) {
    expect(
      (
        await h.context
          .connection()
          .query(`SELECT DISTINCT canvas_id FROM ${table}`)
      ).rows,
    ).toEqual([{ canvas_id: 'neighbor' }]);
  }
  expect(
    (await h.context.connection().query('SELECT body FROM extension_documents'))
      .rows,
  ).toEqual([{ body: '{"private":"neighbor"}' }]);
  expect(await neighbor.nodes.read('node')).not.toBeNull();
});
