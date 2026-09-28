// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

import { PostgresStoreContext } from './database.js';
import { PostgresStructuredStore } from './structured-store.js';
import { openPostgresTestStore } from './test-support.js';
import { PostgresWorkspaceRepository } from './workspace-repository.js';
import { event, note, task, run } from '../sql/test-fixtures.js';

import type { SpaceSubstrate } from '../../ports/structured.js';

/**
 * Write one row into a table this test owns, through the substrate.
 *
 * The port hands an owner a place and nothing else, so proving that a place
 * cascades means bringing a table. The agent module has helpers of its own
 * over the same substrate; borrowing them here would point storage at a
 * consumer, which is the direction this module does not import in.
 */
async function seedOwnedRow(
  substrate: SpaceSubstrate | null,
  body: string,
): Promise<void> {
  if (substrate?.kind !== 'postgres')
    throw new Error('Expected a Postgres substrate');
  await substrate.database.query(
    `CREATE TABLE IF NOT EXISTS owner_rows (
       extension_id INTEGER NOT NULL
         REFERENCES space_extensions(extension_id) ON DELETE CASCADE,
       body TEXT NOT NULL)`,
  );
  await substrate.database.query('INSERT INTO owner_rows VALUES ($1, $2)', [
    substrate.extensionId,
    body,
  ]);
}

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

it('fences peer mutations during deletion and releases admission on abort and finish', async () => {
  const h = await open();
  const peer = new PostgresStoreContext({
    ...h.config,
    max: 1,
    application_name: 'deletion-peer',
    options: `${h.config.options},public`,
  });
  cleanup.push(() => peer.close());
  await peer.init();
  peer.useWorkspace(h.workspaceId);
  const second = new PostgresStructuredStore(peer);
  const space = second.space('space');
  const isolated = await open();
  for (const finish of [false, true]) {
    const deletion = await h.store.spaces().beginDelete({ canvasId: 'space' });
    if (!deletion.ok) throw new Error('Expected deletion session');
    try {
      await expect(
        space.nodes.put({ nodeId: 'node', record: note() }),
      ).rejects.toThrow(/deletion is pending/);
      await expect(space.tasks.create(task())).rejects.toThrow(
        /deletion is pending/,
      );
      await expect(space.events.append([event()])).rejects.toThrow(
        /deletion is pending/,
      );
      await expect(space.extension('agent.documents')).rejects.toThrow(
        /deletion is pending/,
      );
      // The same canvas id in a different schema has independent admission.
      expect(
        await isolated.store
          .space('space')
          .nodes.put({ nodeId: 'node', record: note() }),
      ).toMatchObject({ ok: true });
      if (finish) {
        await deletion.session.finish();
        await second.spaces().create({ canvasId: 'space', title: 'Recreated' });
      }
    } finally {
      await deletion.session.abort();
    }
    expect(
      await space.nodes.put({ nodeId: 'node', record: note() }),
    ).toMatchObject({ ok: true });
  }
});

it('drains a peer transaction and its queued writes before granting deletion', async () => {
  const h = await open();
  const peer = new PostgresStoreContext(h.config);
  cleanup.push(() => peer.close());
  await peer.init();
  peer.useWorkspace(h.workspaceId);
  const space = new PostgresStructuredStore(peer).space('space');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const running = peer.transaction(async (db) => {
    await db.run(
      'UPDATE spaces SET title = ? WHERE canvas_id = ?',
      'Admitted',
      'space',
    );
    entered();
    await gate;
  });
  await started;
  const queued = space.nodes.put({ nodeId: 'node', record: note() });
  const acquired = vi.fn();
  const deletion = h.context.acquireDelete('space').then((release) => {
    acquired();
    return release;
  });
  try {
    // Let the event loop turn while the real transaction remains open.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquired).not.toHaveBeenCalled();
    await expect(space.events.append([event()])).rejects.toThrow(
      /deletion is pending/,
    );
  } finally {
    resume();
    const release = await deletion;
    try {
      await running;
      expect(await queued).toMatchObject({ ok: true });
      expect((await space.read())?.title).toBe('Admitted');
      expect(await space.nodes.read('node')).not.toBeNull();
    } finally {
      release();
    }
  }
});

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

it('resolves an existing extension namespace without drawing identity values', async () => {
  const h = await open();
  const space = h.store.space('space');
  const first = await space.extension('agent.first');
  for (let i = 0; i < 3; i++)
    expect(await space.extension('agent.first')).toEqual(first);
  const second = await space.extension('agent.second');
  if (first?.kind !== 'postgres' || second?.kind !== 'postgres')
    throw new Error('Expected Postgres substrates');
  // Memory reads resolve their namespace on every turn; an upsert would burn
  // one INTEGER identity per call until the sequence is exhausted.
  expect(second.extensionId).toBe(first.extensionId + 1);
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
    await seedOwnedRow(
      await handle.extension('owner.rows'),
      `private:${handle.canvasId}`,
    );
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
    (await h.context.connection().query('SELECT body FROM owner_rows')).rows,
  ).toEqual([{ body: 'private:neighbor' }]);
  expect(await neighbor.nodes.read('node')).not.toBeNull();
});
