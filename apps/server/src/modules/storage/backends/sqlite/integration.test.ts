// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

import {
  applySqliteMigrations,
  SqliteStoreContext,
  SQLITE_SCHEMA_VERSION,
} from './database.js';
import { SqliteStructuredStore } from './structured-store.js';
import {
  createSqliteTestFile,
  installDeltaAbortTrigger,
  openSqliteTestStore,
  readSqliteDeltaLog,
  withTestDatabase,
} from './test-support.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

import type {
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type { NodeSnapshot } from '../../ports/structured.js';
import type { TaskRecord } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const cleanups: Array<() => Promise<void> | void> = [];

it.each([undefined, 1, 0, -1, NaN, Infinity])(
  'validates older persisted events before applying limit %s',
  async (limit) => {
    const { store, filename, world } = await trackedOpenStore(
      'huabu-event-corruption-',
    );
    const records = [
      '{}',
      JSON.stringify({
        ts: 2,
        payload: {
          action: 'node_selected',
          node: { id: 'n1', type: 'note', label: 'Note' },
        },
      }),
    ];
    withTestDatabase(filename, (database) => {
      const insert = database.prepare(
        'INSERT INTO events (canvas_id, event_json) VALUES (?, ?)',
      );
      for (const record of records) insert.run(world.canvasId, record);
    });
    await expect(
      store.space(world.canvasId).events.read(limit),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(
      withTestDatabase(filename, (database) =>
        database
          .prepare(
            'SELECT event_json FROM events WHERE canvas_id = ? ORDER BY event_id',
          )
          .all(world.canvasId)
          .map((row) => row['event_json']),
      ),
    ).toEqual(records);
  },
);

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

/** A tracked context, so a test can drive the shared connection directly. */
function trackedContext(filename: string): SqliteStoreContext {
  const context = new SqliteStoreContext(filename);
  cleanups.push(() => context.close());
  return context;
}

/**
 * Open a store on an existing file and activate a Workspace on it.
 *
 * Reopening is the interesting half of persistence, and every Space query is
 * Workspace-scoped, so a reopened store has to select one before it can read
 * anything — exactly as a restarted Server does.
 */
async function reopenWithWorkspace(
  filename: string,
): Promise<SqliteStructuredStore> {
  const context = trackedContext(filename);
  context.init();
  const workspaces = new SqliteWorkspaceRepository(context);
  const [first] = await workspaces.list();
  if (!first) throw new Error('Reopened SQLite database holds no Workspace');
  context.useWorkspace(first.workspaceId);
  return new SqliteStructuredStore(context);
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
      Promise.resolve().then(() =>
        store.space('lifecycle-space').nodes.readMany([]),
      ),
    ).rejects.toThrow(/not initialized/);

    await expect(store.init()).resolves.toBeUndefined();
    await expect(store.init()).resolves.toBeUndefined();
    await expect(store.health()).resolves.toEqual({ ok: true, kind: 'sqlite' });
    await expect(store.health()).resolves.toEqual({ ok: true, kind: 'sqlite' });

    // Open is not the same as ready: a Space query needs a Workspace, and an
    // open store with none says so rather than answering for an arbitrary one.
    await expect(
      Promise.resolve().then(() => store.spaces().list()),
    ).rejects.toThrow(/No Workspace is active/);

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
      Promise.resolve().then(() =>
        store.space('lifecycle-space').nodes.readMany([]),
      ),
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
        'workspaces',
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
      expect(
        database
          .prepare('PRAGMA foreign_key_list(spaces)')
          .all()
          .map((row) => ({
            table: row['table'],
            from: row['from'],
            to: row['to'],
            onDelete: row['on_delete'],
          })),
      ).toContainEqual({
        table: 'workspaces',
        from: 'workspace_id',
        to: 'workspace_id',
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

    const store = await reopenWithWorkspace(file.filename);
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

    harness.closeConnection();
    const reopened = await reopenWithWorkspace(harness.filename);

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

    harness.closeConnection();
    const reopened = await reopenWithWorkspace(harness.filename);
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

describe('SqliteStructuredStore durability and encoding', () => {
  it('opens in WAL with a bounded busy wait and foreign keys enforced', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-pragmas-');

    withTestDatabase(harness.filename, (database) => {
      // Read on a *second* connection: `journal_mode` is a property of the
      // database file, so this proves the mode was actually persisted rather
      // than set on the adapter's own handle and forgotten.
      expect(database.prepare('PRAGMA journal_mode').get()).toEqual({
        journal_mode: 'wal',
      });
    });
    const database = harness.context.database();
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(
      Number(database.prepare('PRAGMA busy_timeout').get()?.['timeout']),
    ).toBeGreaterThan(0);
  });

  it('accepts an undefined field the way JSON.stringify does', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-undefined-');
    const canvasId = 'undefined-field-space';
    const base = await createSpace(harness.store, canvasId, 'Undefined Space');
    const handle = harness.store.space(canvasId);

    // Disk persists through `JSON.stringify`, which drops an undefined own
    // property. A record it accepts must not become a rejected write here —
    // that divergence is invisible until a caller happens to spread an
    // optional field onto a node.
    const next = {
      ...base,
      version: 1,
      state: {
        nodes: [
          {
            id: 'node-undefined',
            type: 'note',
            position: { x: 0, y: 0 },
            data: { kept: 'yes', dropped: undefined },
          },
        ],
        edges: [],
      },
    } as unknown as CanvasFile;
    await expect(
      handle.write({ expectedVersion: 0, nextRecord: next, nodeMutations: [] }),
    ).resolves.toEqual({ ok: true });
    const stored = await handle.read();
    expect(
      (stored?.state.nodes[0] as { data: Record<string, unknown> }).data,
    ).toEqual({ kept: 'yes' });

    // What is genuinely unrepresentable still rejects.
    const cyclic: Record<string, unknown> = { id: 'node-cyclic' };
    cyclic['self'] = cyclic;
    await expect(
      handle.write({
        expectedVersion: 1,
        nextRecord: {
          ...base,
          version: 2,
          state: { nodes: [cyclic], edges: [] },
        } as unknown as CanvasFile,
        nodeMutations: [],
      }),
    ).rejects.toThrow(/cycle/);
    await expect(
      handle.write({
        expectedVersion: 1,
        nextRecord: {
          ...base,
          version: 2,
          state: { nodes: [{ id: 'n', size: Number.NaN }], edges: [] },
        } as unknown as CanvasFile,
        nodeMutations: [],
      }),
    ).rejects.toThrow(/non-finite/);
  });

  it('delivers streamed nodes before the scan finishes and stops on abort', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-stream-');
    const canvasId = 'stream-space';
    await createSpace(harness.store, canvasId, 'Stream Space');
    const nodes = harness.store.space(canvasId).nodes;
    for (let index = 0; index < 6; index += 1) {
      const put = await nodes.put({
        nodeId: `node-${index}`,
        record: note(`node-${index}`, `Node ${index}`, `body ${index}`),
      });
      if (!put.ok) throw new Error('Could not seed a stream node');
    }

    const signal = { aborted: false };
    const seen: NodeSnapshot[] = [];
    const delivered = await nodes.stream(
      (snapshot) => {
        seen.push(snapshot);
        if (seen.length === 2) signal.aborted = true;
      },
      { signal },
    );

    // An aborted scan stops reading rather than materializing the whole
    // collection first and discarding it, so the map it settles with is the
    // partial one the port describes.
    expect(seen).toHaveLength(2);
    expect(delivered.size).toBe(2);
    await expect(nodes.list()).resolves.toHaveProperty('size', 6);

    const complete: string[] = [];
    const all = await nodes.stream((snapshot) =>
      complete.push(snapshot.record.nodeId),
    );
    expect(complete).toHaveLength(6);
    expect(all.size).toBe(6);
  });

  it('reads a batch of nodes in one pass, including duplicates and absences', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-readmany-');
    const canvasId = 'readmany-space';
    await createSpace(harness.store, canvasId, 'ReadMany Space');
    const nodes = harness.store.space(canvasId).nodes;
    for (const nodeId of ['a', 'b', 'c']) {
      await nodes.put({
        nodeId,
        record: note(nodeId, `Node ${nodeId}`, nodeId),
      });
    }

    const selection = await nodes.readMany(['a', 'a', 'missing', 'c']);
    expect([...selection.keys()].sort()).toEqual(['a', 'c']);
    expect(selection.get('a')).toEqual(await nodes.read('a'));
  });

  it('scopes every Space operation to the active Workspace', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-workspaces-');
    const first = harness.workspaceId;
    await createSpace(harness.store, 'workspace-a-space', 'Space A');

    const workspaces = new SqliteWorkspaceRepository(harness.context);
    const second = await workspaces.create('Second Workspace');
    const retained = harness.store.space('workspace-a-space');

    harness.context.useWorkspace(second.workspaceId);
    // A Space in another Workspace is not visible, and a handle resolved
    // before the switch refuses rather than answering for the new namespace.
    await expect(harness.store.spaces().list()).resolves.toEqual([]);
    await expect(
      harness.store.space('workspace-a-space').read(),
    ).resolves.toBeNull();
    await expect(retained.read()).rejects.toThrow(/inactive Workspace/);

    // Same title, different Workspace: no collision, no suffix.
    const created = await harness.store
      .spaces()
      .create({ canvasId: 'workspace-b-space', title: 'Space A' });
    expect(created).toMatchObject({ ok: true, record: { title: 'Space A' } });

    harness.context.useWorkspace(first);
    await expect(harness.store.spaces().list()).resolves.toHaveLength(1);
  });

  it('keeps a forgotten Workspace out of listings without destroying it', async () => {
    const harness = await trackedOpenStore('huabu-sqlite-forget-');
    const workspaces = new SqliteWorkspaceRepository(harness.context);
    await createSpace(harness.store, 'forgotten-space', 'Forgotten Space');

    await expect(workspaces.remove(harness.workspaceId)).resolves.toBe(true);
    await expect(workspaces.list()).resolves.toEqual([]);
    await expect(workspaces.get(harness.workspaceId)).resolves.toBeNull();
    await expect(workspaces.remove(harness.workspaceId)).resolves.toBe(false);

    // "Forget" is not "delete": the port's wording is deliberate, and on a
    // backend with no folder left behind the rows have to be what honours it.
    expect(
      withTestDatabase(harness.filename, (database) =>
        database
          .prepare('SELECT canvas_id FROM spaces WHERE canvas_id = ?')
          .all('forgotten-space'),
      ),
    ).toHaveLength(1);
  });
});
