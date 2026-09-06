// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

import { applySqliteMigrations, SQLITE_SCHEMA_VERSION } from './database.js';
import { SqliteStructuredStore } from './structured-store.js';
import {
  createSqliteTestFile,
  installDeltaAbortTrigger,
  openSqliteTestStore,
  readSqliteDeltaLog,
  withTestDatabase,
} from './test-support.js';

import type {
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type { NodeSnapshot } from '../../ports/structured.js';
import type { TaskRecord } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function trackedFile(prefix: string) {
  const file = createSqliteTestFile(prefix);
  cleanups.push(file.remove);
  return file;
}

function trackedStore(filename: string): SqliteStructuredStore {
  const store = new SqliteStructuredStore(filename);
  cleanups.push(() => store.close());
  return store;
}

async function trackedOpenStore(prefix: string) {
  const harness = await openSqliteTestStore(prefix);
  cleanups.push(harness.cleanup);
  return harness;
}

function note(nodeId: string, label: string, content: string): NodeContent {
  return { nodeId, type: 'note', label, content };
}

function nextRecord(current: CanvasFile): CanvasFile {
  return {
    ...current,
    version: current.version + 1,
    updatedAt: current.updatedAt + 1,
  };
}

function delta(version: number, marker: string): DeltaLogEntry {
  return {
    version,
    ts: version + 100,
    commands: [{ marker }],
    deltas: [{ marker }],
    originator: { source: 'system' },
  };
}

async function createSpace(
  store: SqliteStructuredStore,
  canvasId: string,
  title: string,
): Promise<CanvasFile> {
  const result = await store.spaces().create({ canvasId, title });
  if (!result.ok) throw new Error(`Could not create test Space ${canvasId}`);
  return result.record;
}

describe('SqliteStructuredStore lifecycle and schema', () => {
  it('rejects an empty database filename', () => {
    expect(() => new SqliteStructuredStore('')).toThrow(/filename.*empty/i);
  });

  it('rejects before init and after close while lifecycle operations stay idempotent', async () => {
    const file = trackedFile('huabu-sqlite-lifecycle-');
    const store = trackedStore(file.filename);

    await expect(store.health()).rejects.toThrow(/not initialized/);
    await expect(
      Promise.resolve().then(() => store.spaces().list()),
    ).rejects.toThrow(/not initialized/);
    await expect(
      Promise.resolve().then(() => store.space('lifecycle-space').read()),
    ).rejects.toThrow(/not initialized/);
    await expect(
      store.space('lifecycle-space').nodes.readMany([]),
    ).rejects.toThrow(/not initialized/);

    await expect(store.init()).resolves.toBeUndefined();
    await expect(store.init()).resolves.toBeUndefined();
    await expect(store.health()).resolves.toEqual({ ok: true, kind: 'sqlite' });
    await expect(store.health()).resolves.toEqual({ ok: true, kind: 'sqlite' });

    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.health()).rejects.toThrow(/closed/);
    await expect(
      Promise.resolve().then(() => store.spaces().list()),
    ).rejects.toThrow(/closed/);
    await expect(
      Promise.resolve().then(() => store.space('lifecycle-space').read()),
    ).rejects.toThrow(/closed/);
    await expect(
      store.space('lifecycle-space').nodes.readMany([]),
    ).rejects.toThrow(/closed/);
    await expect(store.init()).rejects.toThrow(/closed/);
  });

  it('creates the complete STRICT v1 schema in a fresh database', async () => {
    const file = trackedFile('huabu-sqlite-fresh-schema-');
    const store = trackedStore(file.filename);
    await store.init();

    withTestDatabase(file.filename, (database) => {
      expect(database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: SQLITE_SCHEMA_VERSION,
      });
      const expectedTables = [
        'changes',
        'delta_log',
        'events',
        'nodes',
        'space_extensions',
        'spaces',
        'tasks',
      ];
      const tableRows = database.prepare('PRAGMA table_list').all();
      const productionTables = tableRows.filter((row) =>
        expectedTables.includes(String(row['name'])),
      );
      expect(productionTables.map((row) => row['name']).sort()).toEqual(
        expectedTables,
      );
      expect(productionTables.every((row) => row['strict'] === 1)).toBe(true);
      expect(
        database
          .prepare('PRAGMA foreign_key_list(nodes)')
          .all()
          .map((row) => ({
            table: row['table'],
            from: row['from'],
            to: row['to'],
            onDelete: row['on_delete'],
          })),
      ).toContainEqual({
        table: 'spaces',
        from: 'canvas_id',
        to: 'canvas_id',
        onDelete: 'CASCADE',
      });
    });
  });

  it('opens the immutable v1 SQL fixture without rewriting its records', async () => {
    const file = trackedFile('huabu-sqlite-v1-fixture-');
    const fixtureSql = readFileSync(
      new URL('./fixtures/v1.sql', import.meta.url),
      'utf8',
    );
    withTestDatabase(file.filename, (database) => database.exec(fixtureSql));

    const store = trackedStore(file.filename);
    await store.init();
    await expect(store.spaces().worldId()).resolves.toBe('fixture-world');
    await expect(store.spaces().list()).resolves.toEqual([
      {
        canvasId: 'fixture-space',
        title: 'Fixture Space',
        nodeCount: 1,
        createdAt: 10,
        updatedAt: 13,
      },
    ]);
    const space = store.space('fixture-space');
    await expect(space.read()).resolves.toEqual({
      canvasId: 'fixture-space',
      title: 'Fixture Space',
      version: 3,
      state: {
        nodes: [{ id: 'fixture-node', type: 'note' }],
        edges: [],
      },
      createdAt: 10,
      updatedAt: 13,
    });
    await expect(space.nodes.read('fixture-node')).resolves.toEqual({
      record: note('fixture-node', 'Fixture Node', 'fixture body'),
      revision: 'fixture-revision',
    });
    await expect(space.events.read()).resolves.toEqual([
      {
        payload: {
          action: 'node_selected',
          node: { id: 'fixture-node', type: 'note', label: 'Fixture Node' },
        },
        ts: 12,
      },
    ]);
    await expect(space.changes.read('fixture-thread')).resolves.toEqual([]);
    await expect(space.tasks.read()).resolves.toEqual({
      version: 1,
      tasks: [],
      runs: [],
    });
    expect(readSqliteDeltaLog(file.filename, 'fixture-space')).toEqual([
      {
        version: 3,
        ts: 13,
        commands: [],
        deltas: [],
        originator: { source: 'system' },
      },
    ]);
  });

  it('rejects a database whose user_version is from the future', async () => {
    const file = trackedFile('huabu-sqlite-future-schema-');
    withTestDatabase(file.filename, (database) => {
      database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
    });
    const store = trackedStore(file.filename);

    await expect(store.init()).rejects.toThrow(/newer than supported/);
    await expect(store.health()).rejects.toThrow(/closed/);
  });

  it('rolls every migration step and user_version back when a later step fails', () => {
    const file = trackedFile('huabu-sqlite-migration-rollback-');
    withTestDatabase(file.filename, (database) => {
      expect(() =>
        applySqliteMigrations(database, [
          {
            version: 1,
            sql: 'CREATE TABLE migration_v1 (id INTEGER PRIMARY KEY) STRICT;',
          },
          {
            version: 2,
            sql: `
              CREATE TABLE migration_v2 (id INTEGER PRIMARY KEY) STRICT;
              INSERT INTO missing_migration_table (id) VALUES (1);
            `,
          },
        ]),
      ).toThrow(/missing_migration_table|no such table/);

      expect(database.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 0,
      });
      expect(
        database
          .prepare(
            `SELECT name
             FROM sqlite_schema
             WHERE type = 'table' AND name LIKE 'migration_%'`,
          )
          .all(),
      ).toEqual([]);
    });
  });
});

describe('SqliteStructuredStore persistence and transactions', () => {
  it('persists Space and Node records across close and reopen', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-reopen-');
    const canvasId = 'reopen-space';
    const created = await createSpace(harness.store, canvasId, 'Reopen Space');
    const record = note('reopen-node', 'Reopen Node', 'persisted body');
    const put = await harness.store.space(canvasId).nodes.put({
      nodeId: record.nodeId,
      record,
    });
    expect(put).toMatchObject({ ok: true, record });

    await harness.store.close();
    const reopened = trackedStore(harness.filename);
    await reopened.init();

    await expect(reopened.spaces().worldId()).resolves.toBe(
      harness.world.canvasId,
    );
    await expect(reopened.space(canvasId).read()).resolves.toEqual(created);
    await expect(
      reopened.space(canvasId).nodes.read(record.nodeId),
    ).resolves.toEqual(put.ok ? { record, revision: put.revision } : null);
  });

  it('rolls node, record, and delta state back on a real trigger abort', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-trigger-rollback-');
    const canvasId = 'trigger-rollback-space';
    const baseline = await createSpace(
      harness.store,
      canvasId,
      'Trigger Rollback Space',
    );
    const oldNode = note('old-node', 'Old Node', 'before');
    const newNode = note('new-node', 'New Node', 'after');
    const oldPut = await harness.store.space(canvasId).nodes.put({
      nodeId: oldNode.nodeId,
      record: oldNode,
    });
    if (!oldPut.ok) throw new Error('Could not seed rollback node');

    const next: CanvasFile = {
      ...nextRecord(baseline),
      state: {
        nodes: [{ id: newNode.nodeId, type: newNode.type }],
        edges: [],
      },
    };
    const restore = installDeltaAbortTrigger(
      harness.filename,
      'forced delta abort',
    );
    try {
      await expect(
        harness.store.space(canvasId).write({
          expectedVersion: baseline.version,
          nextRecord: next,
          nodeMutations: [
            { kind: 'delete', nodeId: oldNode.nodeId },
            {
              kind: 'put',
              nodeId: newNode.nodeId,
              record: newNode,
              authoritativeInsert: true,
            },
          ],
          delta: delta(next.version, 'trigger-abort'),
        }),
      ).rejects.toThrow('forced delta abort');
    } finally {
      restore();
    }

    const space = harness.store.space(canvasId);
    await expect(space.read()).resolves.toEqual(baseline);
    await expect(space.nodes.read(oldNode.nodeId)).resolves.toEqual({
      record: oldPut.record,
      revision: oldPut.revision,
    });
    await expect(space.nodes.read(newNode.nodeId)).resolves.toBeNull();
    expect(readSqliteDeltaLog(harness.filename, canvasId)).toEqual([]);
    await expect(
      space.nodes.put({
        nodeId: oldNode.nodeId,
        expectedRevision: oldPut.revision,
        record: { ...oldNode, content: 'still writable' },
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('rejects sparse JSON arrays without changing the exact persisted Node', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-sparse-json-');
    const canvasId = 'sparse-json-space';
    await createSpace(harness.store, canvasId, 'Sparse JSON Space');
    const nodes = harness.store.space(canvasId).nodes;
    const record = note('sparse-json-node', 'Sparse JSON Node', 'before');
    const baseline = await nodes.put({ nodeId: record.nodeId, record });
    if (!baseline.ok) throw new Error('Could not seed sparse JSON node');
    const sparse: unknown[] = [];
    sparse[1] = 'present';
    expect(0 in sparse).toBe(false);

    await expect(
      nodes.put({
        nodeId: record.nodeId,
        expectedRevision: baseline.revision,
        record: { ...record, metadata: sparse },
      }),
    ).rejects.toThrow(/sparse array/i);
    await expect(nodes.read(record.nodeId)).resolves.toEqual({
      record,
      revision: baseline.revision,
    });
  });

  it('recovers malformed stored Node content through every read shape', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-node-recovery-');
    const canvasId = 'node-recovery-space';
    await createSpace(harness.store, canvasId, 'Node Recovery Space');
    const nodes = harness.store.space(canvasId).nodes;
    const record = note('recoverable-node', 'Recoverable Node', 'before');
    const baseline = await nodes.put({ nodeId: record.nodeId, record });
    if (!baseline.ok) throw new Error('Could not seed recoverable Node');

    withTestDatabase(harness.filename, (database) => {
      database
        .prepare(
          `UPDATE nodes
           SET record_json = ?
           WHERE canvas_id = ? AND node_id = ?`,
        )
        .run('{"content":"recoverable body"}', canvasId, record.nodeId);
    });

    const recovered: NodeSnapshot = {
      record: {
        nodeId: record.nodeId,
        type: 'note',
        label: null,
        content: 'recoverable body',
      },
      revision: baseline.revision,
    };
    await expect(nodes.read(record.nodeId)).resolves.toEqual(recovered);
    await expect(nodes.readMany([record.nodeId])).resolves.toEqual(
      new Map([[record.nodeId, recovered]]),
    );
    await expect(nodes.list()).resolves.toEqual(
      new Map([[record.nodeId, recovered]]),
    );
    const delivered: NodeSnapshot[] = [];
    await expect(
      nodes.stream((snapshot) => delivered.push(snapshot)),
    ).resolves.toEqual(new Map([[record.nodeId, recovered]]));
    expect(delivered).toEqual([recovered]);

    await expect(
      nodes.put({
        nodeId: record.nodeId,
        expectedRevision: baseline.revision,
        record: { ...record, content: 'repaired' },
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('releases deletion admission when post-acquire Space setup throws', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-delete-setup-');
    const canvasId = 'delete-setup-space';
    const record = await createSpace(
      harness.store,
      canvasId,
      'Delete Setup Space',
    );
    const repository = harness.store.spaces();

    const malformedAttempt = repository.beginDelete({ canvasId });
    withTestDatabase(harness.filename, (database) => {
      database
        .prepare('UPDATE spaces SET state_json = ? WHERE canvas_id = ?')
        .run('[]', canvasId);
    });
    await expect(malformedAttempt).rejects.toThrow(/Invalid Space/);
    withTestDatabase(harness.filename, (database) => {
      database
        .prepare('UPDATE spaces SET state_json = ? WHERE canvas_id = ?')
        .run(JSON.stringify(record.state), canvasId);
    });

    let secondResult:
      | Awaited<ReturnType<typeof repository.beginDelete>>
      | undefined;
    let secondError: unknown;
    const secondSettled = repository.beginDelete({ canvasId }).then(
      (result) => {
        secondResult = result;
      },
      (error: unknown) => {
        secondError = error;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(secondError).toBeUndefined();
    expect(secondResult).toMatchObject({ ok: true });
    if (!secondResult?.ok) {
      throw new Error('Deletion gate remained occupied after setup failure');
    }
    await secondResult.session.abort();
    await secondSettled;
  });

  it('cascades every child record when a deletion session finishes', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-delete-session-');
    const canvasId = 'delete-session-space';
    const baseline = await createSpace(
      harness.store,
      canvasId,
      'Delete Session Space',
    );
    const record = note('deleted-node', 'Deleted Node', 'stale body');
    const handle = harness.store.space(canvasId);
    await handle.nodes.put({ nodeId: record.nodeId, record });
    await handle.events.append([
      {
        payload: {
          action: 'node_selected',
          node: {
            id: record.nodeId,
            type: 'note',
            label: record.label ?? undefined,
          },
        },
        ts: 2,
      },
    ]);
    const changeNode: CanvasNode = {
      id: 'change-node',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { label: 'Change Node', content: 'change body' },
    } as CanvasNode;
    await handle.changes.append(
      'delete-thread',
      extractCanvasChanges([{ type: 'INSERT_NODE', node: changeNode }]),
    );
    const task: TaskRecord = {
      taskId: 'delete-task',
      canvasId,
      goal: 'Delete this fixture',
      defaultRootProfileId: 'profile-delete',
      anchorNodeId: record.nodeId,
      createdAt: 3,
    };
    await handle.tasks.create(task);
    const next = nextRecord(baseline);
    await expect(
      handle.write({
        expectedVersion: baseline.version,
        nextRecord: next,
        nodeMutations: [],
        delta: delta(next.version, 'delete-session'),
      }),
    ).resolves.toEqual({ ok: true });

    withTestDatabase(harness.filename, (database) => {
      for (const table of [
        'nodes',
        'events',
        'changes',
        'tasks',
        'delta_log',
      ]) {
        expect(
          database
            .prepare(
              `SELECT count(*) AS count FROM ${table} WHERE canvas_id = ?`,
            )
            .get(canvasId)?.['count'],
        ).toBe(1);
      }
    });

    const started = await harness.store.spaces().beginDelete({ canvasId });
    if (!started.ok) throw new Error('Ordinary Space must be deletable');
    await expect(handle.read()).resolves.toEqual(next);
    await expect(handle.nodes.read(record.nodeId)).resolves.toMatchObject({
      record,
    });
    await expect(started.session.finish()).resolves.toEqual({
      ok: true,
      reason: 'deleted',
    });

    withTestDatabase(harness.filename, (database) => {
      for (const table of [
        'nodes',
        'events',
        'changes',
        'tasks',
        'delta_log',
      ]) {
        expect(
          database
            .prepare(
              `SELECT count(*) AS count FROM ${table} WHERE canvas_id = ?`,
            )
            .get(canvasId)?.['count'],
        ).toBe(0);
      }
    });

    await expect(handle.read()).resolves.toBeNull();
  });

  it('allows a first write after deleting an already absent node', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-absent-delete-');
    const canvasId = 'absent-delete-space';
    await createSpace(harness.store, canvasId, 'Absent Delete Space');
    const nodes = harness.store.space(canvasId).nodes;
    const record = note('not-yet-created', 'Not Yet Created', 'body');

    await expect(nodes.delete(record.nodeId)).resolves.toBe('absent');
    await expect(
      nodes.put({ nodeId: record.nodeId, record }),
    ).resolves.toMatchObject({ ok: true, record });
  });

  it('allows immediate reuse of a deleted primary key across reopen', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-delete-reopen-');
    const canvasId = 'tombstone-reopen-space';
    await createSpace(harness.store, canvasId, 'Tombstone Reopen Space');
    const record = note('tombstoned-node', 'Tombstoned Node', 'before');
    const nodes = harness.store.space(canvasId).nodes;
    const initial = await nodes.put({ nodeId: record.nodeId, record });
    if (!initial.ok) throw new Error('Could not create initial test Node');

    await expect(nodes.delete(record.nodeId)).resolves.toBe('deleted');
    const recreated = await nodes.put({
      nodeId: record.nodeId,
      record: { ...record, content: 'immediate replacement' },
    });
    if (!recreated.ok) throw new Error('Could not recreate test Node');
    expect(recreated.record).toEqual({
      ...record,
      content: 'immediate replacement',
    });
    expect(recreated.revision).not.toBe(initial.revision);
    await expect(
      nodes.put({
        nodeId: record.nodeId,
        expectedRevision: initial.revision,
        record: { ...record, content: 'stale replacement' },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'revision-conflict',
      currentRevision: recreated.revision,
    });

    await harness.store.close();
    const reopened = trackedStore(harness.filename);
    await reopened.init();
    await expect(
      reopened.space(canvasId).nodes.delete(record.nodeId),
    ).resolves.toBe('deleted');
    await expect(
      reopened.space(canvasId).nodes.put({
        nodeId: record.nodeId,
        record: { ...record, content: 'after reopen' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      record: { ...record, content: 'after reopen' },
    });
  });
});
