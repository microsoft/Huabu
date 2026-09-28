// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What the Postgres conversation stores owe a real server.
 *
 * `sqlite-stores.test.ts` already runs the product-level conversation suite
 * against every SQL profile, so this file is deliberately not a second copy of
 * it. It covers the things that only exist because this backing is a *pool
 * against a shared database*: tables created once under a first-touch burst
 * and across independent pools, a per-thread write lock that has to serialize
 * sequence allocation without serializing the rest of the deployment, clients
 * that come back to the pool when a statement fails, and the foreign keys that
 * make a Space's deletion take its conversation with it.
 *
 * Everything runs through the mounted profile and the real pool. A stub would
 * answer every question here with the answer it was given.
 */

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, expect, it } from 'vitest';

import {
  PostgresEventLogStore,
  PostgresThreadStore,
  PostgresTurnStore,
} from './postgres-stores.js';
import { PostgresStoreContext } from '../../storage/backends/postgres/database.js';
import { PostgresStructuredStore } from '../../storage/backends/postgres/structured-store.js';
import {
  composeStorage,
  deleteSpace,
  setStorageForTesting,
  space,
} from '../../storage/index.js';
import { mountTestWorkspace } from '../../storage/testing.js';

import type { Storage } from '../../storage/index.js';
import type { StructuredStore } from '../../storage/ports/structured.js';
import type { MountedTestStorage } from '../../storage/testing.js';
import type { EventLogEntry, ThreadRecord } from '@agenetes/agenetes';
import type { Namespace } from '@agenetes/protocol';

const PROFILE = {
  structured: { kind: 'postgres' as const },
  blobs: { kind: 'disk' as const },
};

const CANVAS_ID = 'canvas-pg-conversation';
const OTHER_ID = 'canvas-pg-other';
const THREAD_ID = 'thread-1';

const threads = new PostgresThreadStore();
const events = new PostgresEventLogStore();
const turns = new PostgresTurnStore();

let mounted: MountedTestStorage | null = null;
const disposals: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  await mounted?.close();
  mounted = null;
});

/** Open the Postgres profile and create the Spaces a case needs. */
async function openWorkspace(
  ...canvasIds: readonly string[]
): Promise<MountedTestStorage> {
  const opened = await mountTestWorkspace(PROFILE, 'huabu-agenetes-pg-');
  mounted = opened;
  for (const canvasId of canvasIds) {
    const created = await opened.storage.structured
      .spaces()
      .create({ canvasId, title: canvasId });
    if (!created.ok) throw new Error(`Expected to create ${canvasId}`);
  }
  return opened;
}

/** The place this Space's conversations live, resolved the way the store does. */
async function substrateOf(canvasId: string) {
  const value = await space(canvasId).extension('agenetes.conversations');
  if (value?.kind !== 'postgres')
    throw new Error('Expected a Postgres conversation substrate');
  return value;
}

function namespace(canvasId: string): Namespace {
  return { name: canvasId };
}

function threadRecord(marker: string, threadId = THREAD_ID): ThreadRecord {
  return {
    driverSchemaVersion: 1,
    spec: {
      kind: 'test',
      workloadType: 'Deployment',
      threadId,
      namespace: { name: CANVAS_ID },
      spec: {},
    },
    state: { driverState: { marker } },
  } as unknown as ThreadRecord;
}

function turnFor(content: string | null, seq: number) {
  return {
    turn: {
      request: content === null ? null : { type: 'user_text', content },
      transcript: [],
    },
    seqStart: seq,
    seqEnd: seq,
  } as never;
}

/** The conversation tables this schema actually has. */
async function conversationTables(database: Pool): Promise<string[]> {
  return (
    await database.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'agenetes%'
       ORDER BY table_name`,
    )
  ).rows.map((row) => String(row.table_name));
}

const ALL_TABLES = [
  'agenetes_events',
  'agenetes_threads',
  'agenetes_turn_generations',
  'agenetes_turns',
];

/** Everything one Space's extension row owns, counted per table. */
async function conversationRows(database: Pool, extensionId: number) {
  const [threadRows, eventRows, turnRows, generationRows] = await Promise.all(
    ['threads', 'events', 'turns', 'turn_generations'].map(async (table) =>
      Number(
        (
          await database.query(
            `SELECT COUNT(*) AS rows FROM agenetes_${table} WHERE extension_id = $1`,
            [extensionId],
          )
        ).rows[0].rows,
      ),
    ),
  );
  return {
    threads: threadRows,
    events: eventRows,
    turns: turnRows,
    generations: generationRows,
  };
}

/**
 * Begin an operation against `storage` and hand back its promise.
 *
 * A store resolves its Space through the process-wide facade at the moment it
 * is called, so restoring the facade before the promise settles is what lets
 * two independent pools have work in flight at the same time. The first case
 * below is the check that this is true rather than convenient.
 */
function start<T>(storage: Storage, operation: () => Promise<T>): Promise<T> {
  const restore = setStorageForTesting(storage);
  try {
    return operation();
  } finally {
    restore();
  }
}

/** A second process's view of the same database: its own context and pool. */
async function peerStorage(opened: MountedTestStorage): Promise<Storage> {
  const connectionString = process.env['HUABU_POSTGRES_URL'];
  if (!connectionString) throw new Error('Expected a Postgres URL to peer on');
  const context = new PostgresStoreContext({ connectionString });
  disposals.push(() => context.close());
  await context.init();
  const workspaceId = (
    await (
      await substrateOf(CANVAS_ID)
    ).database.query('SELECT workspace_id FROM spaces WHERE canvas_id = $1', [
      CANVAS_ID,
    ])
  ).rows[0]?.workspace_id;
  if (typeof workspaceId !== 'string')
    throw new Error('Expected the Space to name a Workspace');
  context.useWorkspace(workspaceId);
  return composeStorage(
    opened.storage.profile,
    new PostgresStructuredStore(context),
    opened.storage.blobs,
  );
}

/**
 * Refuse one SQL write, the way the SQLite suite injects a trigger.
 *
 * Fault injection at the statement is the only honest way to ask what a
 * half-finished transaction leaves behind: an error thrown from the adapter
 * would never have reached the database at all.
 */
async function rejectWrite(
  database: Pool,
  table: string,
  condition: string,
  message: string,
): Promise<() => Promise<void>> {
  const name = `reject_${table}`;
  await database.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF ${condition} THEN RAISE EXCEPTION '${message}'; END IF;
     RETURN NEW; END $$;
     CREATE TRIGGER ${name} BEFORE INSERT ON agenetes_${table}
     FOR EACH ROW EXECUTE FUNCTION ${name}();`,
  );
  return async () => {
    await database.query(
      `DROP TRIGGER ${name} ON agenetes_${table}; DROP FUNCTION ${name}()`,
    );
  };
}

it('creates the conversation tables once under a burst of first-touch writes', async () => {
  const opened = await openWorkspace(CANVAS_ID);
  const ns = namespace(CANVAS_ID);
  const { database } = await substrateOf(CANVAS_ID);
  expect(await conversationTables(database)).toEqual([]);

  // Every one of these is a first touch: the memo that makes bootstrap
  // once-per-pool has nothing in it yet, so they all arrive at the advisory
  // lock together.
  await Promise.all([
    ...Array.from({ length: 6 }, (_, i) =>
      threads.upsert(ns, `thread-${i}`, threadRecord('burst', `thread-${i}`)),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      events.append(ns, `thread-${i}`, { type: 'text', text: 'x' } as never),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      turns.append(ns, `thread-${i}`, turnFor('q', 1)),
    ),
  ]);

  expect(await conversationTables(database)).toEqual(ALL_TABLES);
  expect(await threads.list(ns)).toHaveLength(6);
  await opened.reopen();
  expect(await threads.list(ns)).toHaveLength(6);
});

it('binds an operation to the storage in force when it is called', async () => {
  const opened = await openWorkspace(CANVAS_ID);
  const moved = composeStorage(
    opened.storage.profile,
    {
      kind: 'postgres',
      space: () => {
        throw new Error('The facade has already moved on');
      },
    } as unknown as StructuredStore,
    opened.storage.blobs,
  );

  const pending = start(opened.storage, () =>
    threads.upsert(namespace(CANVAS_ID), THREAD_ID, threadRecord('bound')),
  );
  const restore = setStorageForTesting(moved);
  try {
    await pending;
  } finally {
    restore();
  }
  expect(await threads.get(namespace(CANVAS_ID), THREAD_ID)).toEqual(
    threadRecord('bound'),
  );
});

it('lets two independent pools reach the tables for the first time at once', async () => {
  const opened = await openWorkspace(CANVAS_ID);
  const peer = await peerStorage(opened);
  const ns = namespace(CANVAS_ID);
  const { database } = await substrateOf(CANVAS_ID);
  expect(await conversationTables(database)).toEqual([]);

  // Two pools, one database, neither aware of the other. `CREATE TABLE IF NOT
  // EXISTS` alone is not safe against this; the advisory lock is what makes it
  // so.
  await Promise.all([
    ...Array.from({ length: 4 }, (_, i) =>
      start(opened.storage, () =>
        threads.upsert(ns, `primary-${i}`, threadRecord('primary')),
      ),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      start(peer, () => threads.upsert(ns, `peer-${i}`, threadRecord('peer'))),
    ),
  ]);

  expect(await conversationTables(database)).toEqual(ALL_TABLES);
  // One set of tables, so each pool reads what the other wrote.
  expect((await start(peer, () => threads.list(ns))).length).toBe(8);
  expect((await threads.list(ns)).length).toBe(8);
});

it('retries a failed bootstrap instead of poisoning the pool for good', async () => {
  const opened = await openWorkspace(CANVAS_ID);
  const peer = await peerStorage(opened);
  const ns = namespace(CANVAS_ID);
  const { database } = await substrateOf(CANVAS_ID);

  // The parent row the conversation tables hang off is still readable, so the
  // Space resolves and only the schema statement fails — the shape of a
  // bootstrap that loses a race with a migration rather than one with no
  // Space to write into.
  await database.query(
    `ALTER TABLE space_extensions RENAME TO space_extensions_parked;
     CREATE VIEW space_extensions AS SELECT * FROM space_extensions_parked`,
  );
  await expect(
    start(peer, () => threads.upsert(ns, THREAD_ID, threadRecord('retry'))),
  ).rejects.toThrow(/space_extensions/);
  expect(await conversationTables(database)).toEqual([]);
  await database.query(
    `DROP VIEW space_extensions;
     ALTER TABLE space_extensions_parked RENAME TO space_extensions`,
  );

  // Same pool, same context: the failed attempt must not have been remembered
  // as the answer.
  await start(peer, () => threads.upsert(ns, THREAD_ID, threadRecord('retry')));
  expect(await conversationTables(database)).toEqual(ALL_TABLES);
  expect(await threads.get(ns, THREAD_ID)).toEqual(threadRecord('retry'));
});

it('allocates one contiguous sequence when a thread is appended to concurrently', async () => {
  await openWorkspace(CANVAS_ID);
  const ns = namespace(CANVAS_ID);
  const count = 16;

  const appended = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      events.append(ns, THREAD_ID, { type: 'text', text: `e${i}` } as never),
    ),
  );

  expect([...appended.map((entry) => entry.seq)].sort((a, b) => a - b)).toEqual(
    Array.from({ length: count }, (_, i) => i + 1),
  );
  const stored = await events.readRecords(ns, THREAD_ID);
  expect(stored.map((record) => record.seq)).toEqual(
    Array.from({ length: count }, (_, i) => i + 1),
  );
  // Every append kept its own payload: a lost update would show up as a
  // sequence that is contiguous but short of content.
  expect(
    new Set(
      stored.map(
        (record) => (record as EventLogEntry).event as unknown as string,
      ),
    ).size,
  ).toBe(count);
  expect(await events.maxSeq(ns, THREAD_ID)).toBe(count);
});

it('allocates one contiguous ordinal when a thread is folded into concurrently', async () => {
  await openWorkspace(CANVAS_ID);
  const ns = namespace(CANVAS_ID);
  const count = 12;

  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      turns.append(ns, THREAD_ID, turnFor(`q${i}`, i + 1)),
    ),
  );

  const listed = await turns.list(ns, THREAD_ID);
  expect(listed).toHaveLength(count);
  expect(await turns.count(ns, THREAD_ID)).toBe(count);
  // Ordinals are the paging key, so a duplicate would have been a primary-key
  // violation and a gap would leave a page with a hole in it.
  expect(
    [...listed.map((record) => record.seqStart)].sort((a, b) => a - b),
  ).toEqual(Array.from({ length: count }, (_, i) => i + 1));
});

it('holds the write lock per thread, so another thread and another Space keep moving', async () => {
  await openWorkspace(CANVAS_ID, OTHER_ID);
  const ns = namespace(CANVAS_ID);
  const other = namespace(OTHER_ID);
  const blockedThread = `thread-${randomUUID()}`;
  const { extensionId } = await substrateOf(CANVAS_ID);
  // Warm the tables so the contention under test is the thread lock rather
  // than the bootstrap one.
  await events.maxSeq(ns, blockedThread);

  // A connection the store knows nothing about, holding exactly the key
  // `mutate` takes for this one thread.
  const outside = new Pool({
    connectionString: process.env['HUABU_POSTGRES_URL'],
    max: 1,
  });
  disposals.push(() => outside.end());
  await outside.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
    `agenetes:${extensionId}:${blockedThread}`,
  ]);

  let blockedSettled = false;
  const blocked = events.append(ns, blockedThread, {
    type: 'text',
    text: 'blocked',
  } as never);
  void blocked.then(
    () => (blockedSettled = true),
    () => (blockedSettled = true),
  );

  // Same Space, different thread — and a different Space with the same thread
  // id. Neither shares a lock with the one that is stuck.
  expect(
    (await events.append(ns, 'thread-free', { type: 'text' } as never)).seq,
  ).toBe(1);
  expect(
    (await events.append(other, blockedThread, { type: 'text' } as never)).seq,
  ).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(blockedSettled).toBe(false);

  await outside.query('SELECT pg_advisory_unlock_all()');
  expect((await blocked).seq).toBe(1);
});

it('leaves neither rows nor a fresh cursor generation behind when a replacement fails', async () => {
  await openWorkspace(CANVAS_ID);
  const ns = namespace(CANVAS_ID);
  for (let i = 1; i <= 3; i += 1)
    await turns.append(ns, THREAD_ID, turnFor(`q${i}`, i));
  const before = await turns.list(ns, THREAD_ID);
  const cursor = (await turns.page(ns, THREAD_ID, { limit: 1 })).before!;
  const { database, extensionId } = await substrateOf(CANVAS_ID);

  const remove = await rejectWrite(
    database,
    'turns',
    'NEW.ordinal = 2',
    'replacement insert failed',
  );
  await expect(
    turns.replace(ns, THREAD_ID, [
      turnFor('r1', 10),
      turnFor('r2', 11),
      turnFor('r3', 12),
    ]),
  ).rejects.toThrow('replacement insert failed');
  await remove();

  expect(await turns.list(ns, THREAD_ID)).toEqual(before);
  expect(await conversationRows(database, extensionId)).toMatchObject({
    turns: 3,
    generations: 1,
  });
  // The generation bump rides in the same transaction, so a replacement that
  // never landed must not have invalidated the cursors of the arrangement
  // that is still there.
  expect(
    (await turns.page(ns, THREAD_ID, { limit: 1, before: cursor })).groups[0]!
      .turns[0]!.turn.request,
  ).toMatchObject({ content: 'q2' });

  // And one that does land invalidates it.
  await turns.replace(ns, THREAD_ID, before);
  await expect(
    turns.page(ns, THREAD_ID, { limit: 1, before: cursor }),
  ).rejects.toThrow('stale');
});

it('returns its client to the pool every time a write is refused', async () => {
  await openWorkspace(CANVAS_ID);
  const ns = namespace(CANVAS_ID);
  await threads.list(ns);
  const { database } = await substrateOf(CANVAS_ID);
  const remove = await rejectWrite(
    database,
    'threads',
    'TRUE',
    'write refused',
  );

  // More failures than the pool has clients: a transaction that kept its
  // client on the error path would have stranded the pool by now.
  for (let i = 0; i < 12; i += 1)
    await expect(
      threads.upsert(ns, `thread-${i}`, threadRecord('refused')),
    ).rejects.toThrow('write refused');
  await remove();

  expect(await threads.list(ns)).toEqual([]);
  await threads.upsert(ns, THREAD_ID, threadRecord('after'));
  expect(await threads.get(ns, THREAD_ID)).toEqual(threadRecord('after'));
});

// A Postgres connection that dies mid-transaction used to take the whole
// process with it: pg drops its own error listener while a client is checked
// out, so an unexpected disconnection raised an `error` event that nothing was
// listening for. `locked` in `postgres-stores.ts` now keeps an ear on the
// client for the length of the checkout, and releases it as broken when the
// rollback itself fails. That pairing is what this case pins down: the pool
// must not hand a dead client to the next caller.
it('discards a client whose connection died mid-transaction without stranding the pool', async () => {
  await openWorkspace(CANVAS_ID);
  const ns = namespace(CANVAS_ID);
  await threads.list(ns);
  const { database } = await substrateOf(CANVAS_ID);
  // The backend kills itself while the transaction is open, so even the
  // rollback fails — the one case where the client must be destroyed rather
  // than returned.
  await database.query(
    `CREATE FUNCTION kill_backend() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$;
     CREATE TRIGGER kill_backend BEFORE INSERT ON agenetes_threads
     FOR EACH ROW EXECUTE FUNCTION kill_backend();`,
  );
  await expect(
    threads.upsert(ns, THREAD_ID, threadRecord('doomed')),
  ).rejects.toThrow();
  await database.query(
    `DROP TRIGGER kill_backend ON agenetes_threads; DROP FUNCTION kill_backend()`,
  );

  expect(await threads.list(ns)).toEqual([]);
  await threads.upsert(ns, THREAD_ID, threadRecord('after'));
  expect(await threads.get(ns, THREAD_ID)).toEqual(threadRecord('after'));
});

it('takes threads, events, turns and cursor generations with the Space', async () => {
  await openWorkspace(CANVAS_ID, OTHER_ID);
  const ns = namespace(CANVAS_ID);
  const other = namespace(OTHER_ID);
  for (const target of [ns, other]) {
    // The same thread id in both Spaces: the extension row is the only thing
    // keeping them apart.
    await threads.upsert(target, THREAD_ID, threadRecord(target.name));
    await events.appendTurnStart(target, THREAD_ID, null);
    await events.append(target, THREAD_ID, { type: 'text' } as never);
    await turns.append(target, THREAD_ID, turnFor('q1', 1));
    await turns.append(target, THREAD_ID, turnFor(null, 2));
  }
  const { database, extensionId } = await substrateOf(CANVAS_ID);
  const survivor = (await substrateOf(OTHER_ID)).extensionId;
  const populated = { threads: 1, events: 2, turns: 2, generations: 1 };
  expect(await conversationRows(database, extensionId)).toEqual(populated);
  expect(await conversationRows(database, survivor)).toEqual(populated);
  expect(await threads.get(ns, THREAD_ID)).toEqual(threadRecord(CANVAS_ID));
  expect(await threads.get(other, THREAD_ID)).toEqual(threadRecord(OTHER_ID));

  await expect(deleteSpace(CANVAS_ID)).resolves.toEqual({
    ok: true,
    reason: 'deleted',
  });

  expect(await conversationRows(database, extensionId)).toEqual({
    threads: 0,
    events: 0,
    turns: 0,
    generations: 0,
  });
  expect(await conversationRows(database, survivor)).toEqual(populated);
  expect(await threads.get(other, THREAD_ID)).toEqual(threadRecord(OTHER_ID));
  expect(await turns.count(other, THREAD_ID)).toBe(2);
  // A write to the Space that is gone is refused rather than left as an
  // orphan row waiting for an extension id to be reused.
  await expect(
    threads.upsert(ns, THREAD_ID, threadRecord('orphan')),
  ).rejects.toThrow('Cannot persist conversation in a missing Space');
  expect(await conversationRows(database, extensionId)).toEqual({
    threads: 0,
    events: 0,
    turns: 0,
    generations: 0,
  });
});

it('refuses a conversation write to a Space that is not there and reads it as empty', async () => {
  await openWorkspace();
  const ns = namespace('canvas-never-created');
  const missing = 'Cannot persist conversation in a missing Space';

  await expect(
    threads.upsert(ns, THREAD_ID, threadRecord('absent')),
  ).rejects.toThrow(missing);
  await expect(events.appendTurnStart(ns, THREAD_ID, null)).rejects.toThrow(
    missing,
  );
  await expect(
    events.append(ns, THREAD_ID, { type: 'text' } as never),
  ).rejects.toThrow(missing);
  await expect(events.replace(ns, THREAD_ID, [])).rejects.toThrow(missing);
  await expect(turns.append(ns, THREAD_ID, turnFor('q', 1))).rejects.toThrow(
    missing,
  );
  await expect(turns.replace(ns, THREAD_ID, [])).rejects.toThrow(missing);

  // A read is a question about a Space that is not there, and the answer is
  // "nothing" rather than an error a caller would have to special-case.
  expect(await threads.get(ns, THREAD_ID)).toBeUndefined();
  expect(await threads.list(ns)).toEqual([]);
  expect(await events.read(ns, THREAD_ID)).toEqual([]);
  expect(await events.readRecords(ns, THREAD_ID)).toEqual([]);
  expect(await events.maxSeq(ns, THREAD_ID)).toBe(0);
  expect(await turns.list(ns, THREAD_ID)).toEqual([]);
  expect(await turns.count(ns, THREAD_ID)).toBe(0);
  expect(await turns.fence(ns, THREAD_ID)).toBe(0);
  expect(await turns.page(ns, THREAD_ID, { limit: 5 })).toMatchObject({
    groups: [],
    hasMore: false,
  });
  // Deleting what was never there is not an error either.
  await threads.delete(ns, THREAD_ID);
  await events.delete(ns, THREAD_ID);
  await turns.delete(ns, THREAD_ID);
});

it('round-trips awkward payloads and keeps the JSON check doing work', async () => {
  await openWorkspace(CANVAS_ID);
  const ns = namespace(CANVAS_ID);
  let nested: Record<string, unknown> = { leaf: 'café ☕ 中文 🙂' };
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  const payload = {
    // A NUL is legal inside JSON text and illegal as a byte in a Postgres
    // column, so the escaping has to survive the round trip intact.
    awkward: 'a\u0000b \\ " \n\t   </script>',
    unicode: '👩‍👩‍👧‍👦 😀 ünïcødé',
    transcript: 'x'.repeat(300_000),
    nested,
  };

  await threads.upsert(ns, THREAD_ID, {
    ...threadRecord('json'),
    hostMetadata: payload,
  } as unknown as ThreadRecord);
  const appended = await events.append(ns, THREAD_ID, payload as never);
  await turns.append(ns, THREAD_ID, {
    turn: {
      request: { type: 'user_text', content: payload.awkward },
      transcript: [payload],
    },
    seqStart: 1,
    seqEnd: 1,
  } as never);

  expect(
    (await threads.get(ns, THREAD_ID)) as unknown as {
      hostMetadata: unknown;
    },
  ).toMatchObject({ hostMetadata: payload });
  expect((await events.read(ns, THREAD_ID))[0]).toEqual(appended);
  expect((await events.read(ns, THREAD_ID))[0]!.event).toEqual(payload);
  expect((await turns.list(ns, THREAD_ID))[0]!.turn.transcript).toEqual([
    payload,
  ]);

  // The declared column check is load-bearing, not decoration: text that is
  // not JSON cannot reach these tables by any route. Postgres names either
  // the constraint or the cast inside it depending on how it folds the
  // expression; both are the same refusal.
  const refused = /check constraint|invalid input syntax for type json/i;
  const { database, extensionId } = await substrateOf(CANVAS_ID);
  await expect(
    database.query('INSERT INTO agenetes_threads VALUES ($1, $2, $3)', [
      extensionId,
      'thread-direct',
      'not json at all',
    ]),
  ).rejects.toThrow(refused);
  await expect(
    database.query('INSERT INTO agenetes_events VALUES ($1, $2, 1, $3)', [
      extensionId,
      'thread-direct',
      '{"unterminated": ',
    ]),
  ).rejects.toThrow(refused);
  await expect(
    database.query('INSERT INTO agenetes_turns VALUES ($1, $2, 9, 1, 1, $3)', [
      extensionId,
      'thread-direct',
      '',
    ]),
  ).rejects.toThrow(refused);
  expect(await conversationRows(database, extensionId)).toMatchObject({
    threads: 1,
    events: 1,
    turns: 1,
  });
});
