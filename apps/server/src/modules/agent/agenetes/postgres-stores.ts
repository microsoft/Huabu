// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Conversation tables remain owned by Agenetes, attached to storage's parent row. */
import {
  decodeTurnCursor,
  encodeTurnCursor,
  groupPersistedTurns,
  requireTurnPageLimit,
  StaleTurnCursorError,
} from '@agenetes/agenetes';

import { space } from '../../storage/index.js';

import type {
  EventLogEntry,
  EventLogRecord,
  EventLogStore,
  PersistedTurn,
  ThreadRecord,
  ThreadStore,
  TurnStartLogEntry,
  TurnStore,
  TurnStorePage,
  TurnStorePageOptions,
} from '@agenetes/agenetes';
import type { AgentSubmission, Namespace } from '@agenetes/protocol';
import type { Pool, PoolClient } from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agenetes_threads (
 extension_id INTEGER NOT NULL REFERENCES space_extensions(extension_id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK ((record_json::json) IS NOT NULL), PRIMARY KEY(extension_id, thread_id));
CREATE TABLE IF NOT EXISTS agenetes_events (
 extension_id INTEGER NOT NULL REFERENCES space_extensions(extension_id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL, seq INTEGER NOT NULL, record_json TEXT NOT NULL CHECK ((record_json::json) IS NOT NULL), PRIMARY KEY(extension_id, thread_id, seq));
CREATE TABLE IF NOT EXISTS agenetes_turns (
 extension_id INTEGER NOT NULL REFERENCES space_extensions(extension_id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, seq_start INTEGER NOT NULL, seq_end INTEGER NOT NULL,
 turn_json TEXT NOT NULL CHECK ((turn_json::json) IS NOT NULL), PRIMARY KEY(extension_id, thread_id, ordinal));
CREATE TABLE IF NOT EXISTS agenetes_turn_generations (
 extension_id INTEGER NOT NULL REFERENCES space_extensions(extension_id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(extension_id, thread_id));`;
const prepared = new WeakMap<Pool, Promise<void>>();
async function tables(database: Pool): Promise<void> {
  let pending = prepared.get(database);
  if (!pending) {
    pending = (async () => {
      const client = await database.connect();
      // pg-pool drops its own idle listener while a client is checked out and
      // `pg` emits `error` on an unexpected disconnection, so a backend that
      // goes away mid-transaction would raise an unhandled 'error' event and
      // take the process down. The statement's own rejection below is the
      // signal this code acts on; the event only needs an ear.
      const ignoreDisconnect = () => {};
      client.on('error', ignoreDisconnect);
      let broken = false;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query('SELECT pg_advisory_xact_lock(184202607)');
        await client.query(SCHEMA);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
        throw error;
      } finally {
        client.release(broken);
        client.removeListener('error', ignoreDisconnect);
      }
    })();
    prepared.set(database, pending);
    void pending.catch(() => prepared.delete(database));
  }
  await pending;
}
async function substrate(namespace: Namespace) {
  if (!namespace.name) return null;
  const value = await space(namespace.name).extension('agenetes.conversations');
  if (!value) return null;
  if (value.kind !== 'postgres')
    throw new Error('Expected Postgres conversation substrate');
  await tables(value.database);
  return value;
}
async function read<T>(
  namespace: Namespace,
  missing: T,
  operation: (database: Pool, id: number) => Promise<T>,
): Promise<T> {
  const value = await substrate(namespace);
  return value ? operation(value.database, value.extensionId) : missing;
}
type ConversationSubstrate = NonNullable<Awaited<ReturnType<typeof substrate>>>;

/**
 * Run `operation` on one client, in one transaction, under the thread's lock.
 *
 * Reads that span several statements take it too, not just writes. Read
 * committed gives every statement its own snapshot, and statements issued on
 * the pool need not even reach the same connection — so a multi-statement
 * read left outside this can assemble its answer from two different
 * arrangements of a thread whose log was replaced between them.
 */
async function locked<T>(
  value: ConversationSubstrate,
  threadId: string,
  operation: (database: PoolClient, id: number) => Promise<T>,
): Promise<T> {
  const client = await value.database.connect();
  // pg-pool drops its own idle listener while a client is checked out and
  // `pg` emits `error` on an unexpected disconnection, so a backend that
  // goes away mid-transaction would raise an unhandled 'error' event and
  // take the process down. The statement's own rejection below is the
  // signal this code acts on; the event only needs an ear.
  const ignoreDisconnect = () => {};
  client.on('error', ignoreDisconnect);
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`agenetes:${value.extensionId}:${threadId}`],
    );
    const result = await operation(client, value.extensionId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
    client.removeListener('error', ignoreDisconnect);
  }
}

async function mutate<T>(
  namespace: Namespace,
  threadId: string,
  operation: (database: PoolClient, id: number) => Promise<T>,
): Promise<T> {
  const value = await substrate(namespace);
  if (!value) throw new Error('Cannot persist conversation in a missing Space');
  return await locked(value, threadId, operation);
}

/** A read whose statements have to agree with each other; see {@link locked}. */
async function readLocked<T>(
  namespace: Namespace,
  threadId: string,
  missing: T,
  operation: (database: PoolClient, id: number) => Promise<T>,
): Promise<T> {
  const value = await substrate(namespace);
  return value ? await locked(value, threadId, operation) : missing;
}

export class PostgresThreadStore implements ThreadStore {
  async upsert(
    namespace: Namespace,
    threadId: string,
    record: ThreadRecord,
  ): Promise<void> {
    await mutate(namespace, threadId, async (db, id) => {
      await db.query(
        `INSERT INTO agenetes_threads VALUES ($1, $2, $3)
      ON CONFLICT(extension_id, thread_id) DO UPDATE SET record_json = excluded.record_json`,
        [id, threadId, JSON.stringify(record)],
      );
    });
  }
  async get(
    namespace: Namespace,
    threadId: string,
  ): Promise<ThreadRecord | undefined> {
    return read(namespace, undefined, async (db, id) => {
      const row = (
        await db.query(
          'SELECT record_json FROM agenetes_threads WHERE extension_id=$1 AND thread_id=$2',
          [id, threadId],
        )
      ).rows[0];
      return row ? (JSON.parse(row.record_json) as ThreadRecord) : undefined;
    });
  }
  async list(namespace: Namespace): Promise<ThreadRecord[]> {
    return read(namespace, [], async (db, id) =>
      (
        await db.query(
          'SELECT record_json FROM agenetes_threads WHERE extension_id=$1 ORDER BY thread_id',
          [id],
        )
      ).rows.map((row) => JSON.parse(row.record_json) as ThreadRecord),
    );
  }
  async delete(namespace: Namespace, threadId: string): Promise<void> {
    if (!(await substrate(namespace))) return;
    await mutate(namespace, threadId, async (db, id) => {
      await db.query(
        'DELETE FROM agenetes_threads WHERE extension_id=$1 AND thread_id=$2',
        [id, threadId],
      );
    });
  }
}

export class PostgresEventLogStore implements EventLogStore {
  private async appendRecord(
    namespace: Namespace,
    threadId: string,
    record: Omit<EventLogEntry, 'seq'> | Omit<TurnStartLogEntry, 'seq'>,
  ): Promise<EventLogRecord> {
    return mutate(namespace, threadId, async (db, id) => {
      const max = (
        await db.query(
          'SELECT COALESCE(MAX(seq),0) AS seq FROM agenetes_events WHERE extension_id=$1 AND thread_id=$2',
          [id, threadId],
        )
      ).rows[0].seq;
      const entry = { ...record, seq: Number(max) + 1 };
      await db.query('INSERT INTO agenetes_events VALUES ($1,$2,$3,$4)', [
        id,
        threadId,
        entry.seq,
        JSON.stringify(entry),
      ]);
      return entry;
    });
  }
  async appendTurnStart(
    namespace: Namespace,
    threadId: string,
    request: AgentSubmission | null,
  ): Promise<TurnStartLogEntry> {
    return (await this.appendRecord(namespace, threadId, {
      kind: 'turn_start',
      request,
      ts: Date.now(),
    })) as TurnStartLogEntry;
  }
  async append(
    namespace: Namespace,
    threadId: string,
    event: EventLogEntry['event'],
  ): Promise<EventLogEntry> {
    return (await this.appendRecord(namespace, threadId, {
      event,
      ts: Date.now(),
    })) as EventLogEntry;
  }
  async readRecords(
    namespace: Namespace,
    threadId: string,
    sinceSeq = 0,
  ): Promise<EventLogRecord[]> {
    return read(namespace, [], async (db, id) =>
      (
        await db.query(
          'SELECT record_json FROM agenetes_events WHERE extension_id=$1 AND thread_id=$2 AND seq>$3 ORDER BY seq',
          [id, threadId, sinceSeq],
        )
      ).rows.map((row) => JSON.parse(row.record_json) as EventLogRecord),
    );
  }
  async read(
    namespace: Namespace,
    threadId: string,
    sinceSeq = 0,
  ): Promise<EventLogEntry[]> {
    return (await this.readRecords(namespace, threadId, sinceSeq)).filter(
      (row): row is EventLogEntry => !('kind' in row),
    );
  }
  async maxSeq(namespace: Namespace, threadId: string): Promise<number> {
    return read(namespace, 0, async (db, id) =>
      Number(
        (
          await db.query(
            'SELECT COALESCE(MAX(seq),0) AS seq FROM agenetes_events WHERE extension_id=$1 AND thread_id=$2',
            [id, threadId],
          )
        ).rows[0].seq,
      ),
    );
  }
  async replace(
    namespace: Namespace,
    threadId: string,
    records: readonly EventLogRecord[],
  ): Promise<void> {
    await mutate(namespace, threadId, async (db, id) => {
      await db.query(
        'DELETE FROM agenetes_events WHERE extension_id=$1 AND thread_id=$2',
        [id, threadId],
      );
      for (const row of records)
        await db.query('INSERT INTO agenetes_events VALUES ($1,$2,$3,$4)', [
          id,
          threadId,
          row.seq,
          JSON.stringify(row),
        ]);
    });
  }
  async delete(namespace: Namespace, threadId: string): Promise<void> {
    if (!(await substrate(namespace))) return;
    await mutate(namespace, threadId, async (db, id) => {
      await db.query(
        'DELETE FROM agenetes_events WHERE extension_id=$1 AND thread_id=$2',
        [id, threadId],
      );
    });
  }
}

export class PostgresTurnStore implements TurnStore {
  /**
   * The thread's cursor generation, created on first use.
   *
   * A cursor is only meaningful against the ordinals it was issued for, so a
   * wholesale `replace` or `delete` bumps this counter and every cursor from
   * the previous arrangement is refused rather than silently repointed.
   */
  async #generation(
    db: Pool | PoolClient,
    extensionId: number,
    threadId: string,
  ): Promise<number> {
    const existing = (
      await db.query(
        'SELECT generation FROM agenetes_turn_generations WHERE extension_id=$1 AND thread_id=$2',
        [extensionId, threadId],
      )
    ).rows[0];
    if (existing) return Number(existing.generation);
    // Two readers can reach this together; the conflict clause makes the
    // loser read the winner's row instead of failing the page.
    return Number(
      (
        await db.query(
          `INSERT INTO agenetes_turn_generations VALUES ($1,$2,1)
           ON CONFLICT(extension_id, thread_id) DO UPDATE SET
             generation = agenetes_turn_generations.generation
           RETURNING generation`,
          [extensionId, threadId],
        )
      ).rows[0].generation,
    );
  }

  /** Start a new generation, so cursors issued before this write are stale. */
  async #bumpGeneration(
    db: PoolClient,
    extensionId: number,
    threadId: string,
  ): Promise<void> {
    await db.query(
      `INSERT INTO agenetes_turn_generations VALUES ($1,$2,2)
       ON CONFLICT(extension_id, thread_id) DO UPDATE SET
         generation = agenetes_turn_generations.generation + 1`,
      [extensionId, threadId],
    );
  }

  async append(
    namespace: Namespace,
    threadId: string,
    record: PersistedTurn,
  ): Promise<void> {
    await mutate(namespace, threadId, async (db, id) => {
      await this.#generation(db, id, threadId);
      const max = Number(
        (
          await db.query(
            'SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM agenetes_turns WHERE extension_id=$1 AND thread_id=$2',
            [id, threadId],
          )
        ).rows[0].ordinal,
      );
      await db.query('INSERT INTO agenetes_turns VALUES ($1,$2,$3,$4,$5,$6)', [
        id,
        threadId,
        max + 1,
        record.seqStart,
        record.seqEnd,
        JSON.stringify(record.turn),
      ]);
    });
  }
  async list(namespace: Namespace, threadId: string): Promise<PersistedTurn[]> {
    return read(namespace, [], async (db, id) =>
      (
        await db.query(
          'SELECT seq_start, seq_end, turn_json FROM agenetes_turns WHERE extension_id=$1 AND thread_id=$2 ORDER BY ordinal',
          [id, threadId],
        )
      ).rows.map((row) => ({
        seqStart: Number(row.seq_start),
        seqEnd: Number(row.seq_end),
        turn: JSON.parse(row.turn_json) as PersistedTurn['turn'],
      })),
    );
  }
  async page(
    namespace: Namespace,
    threadId: string,
    options: TurnStorePageOptions,
  ): Promise<TurnStorePage> {
    requireTurnPageLimit(options.limit);
    // The whole page is assembled inside one locked transaction. Its pieces —
    // the generation the cursors are stamped with, the upper bound, the group
    // starts and the turns themselves — only describe one conversation if a
    // wholesale replacement cannot land between them.
    return await readLocked<TurnStorePage>(
      namespace,
      threadId,
      {
        groups: [],
        next: encodeTurnCursor({
          version: 1,
          threadId,
          generation: 1,
          ordinal: 1,
        }),
        hasMore: false,
      },
      async (database, extensionId) => {
        const generation = await this.#generation(
          database,
          extensionId,
          threadId,
        );
        const cursor = options.before
          ? decodeTurnCursor(options.before, threadId)
          : undefined;
        if (cursor && cursor.generation !== generation) {
          throw new StaleTurnCursorError('History cursor is stale');
        }
        const end =
          cursor?.ordinal ??
          Number(
            (
              await database.query(
                `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM agenetes_turns
             WHERE extension_id=$1 AND thread_id=$2`,
                [extensionId, threadId],
              )
            ).rows[0].ordinal,
          );
        // One display group starts at each turn that carries a request; a
        // requestless turn continues the group before it.
        const starts = (
          await database.query(
            `SELECT ordinal FROM agenetes_turns
         WHERE extension_id=$1 AND thread_id=$2 AND ordinal < $3
           AND json_typeof((turn_json::json) -> 'request') <> 'null'
         ORDER BY ordinal DESC LIMIT $4`,
            [extensionId, threadId, end, options.limit + 1],
          )
        ).rows.map((row) => Number(row.ordinal));
        // A log that opens with requestless turns still has a first group.
        const first = (
          await database.query(
            `SELECT ordinal, json_typeof((turn_json::json) -> 'request') AS request_type
         FROM agenetes_turns
         WHERE extension_id=$1 AND thread_id=$2 AND ordinal < $3
         ORDER BY ordinal LIMIT 1`,
            [extensionId, threadId, end],
          )
        ).rows[0];
        if (
          first &&
          first.request_type === 'null' &&
          starts.length <= options.limit
        )
          starts.push(Number(first.ordinal));
        starts.sort((a, b) => b - a);
        const selectedStarts = starts.slice(0, options.limit);
        const hasMore = starts.length > options.limit;
        if (selectedStarts.length === 0) {
          return {
            groups: [],
            next: encodeTurnCursor({
              version: 1,
              threadId,
              generation,
              ordinal: end,
            }),
            hasMore: false,
          };
        }
        const lower = selectedStarts[selectedStarts.length - 1]!;
        const persisted = (
          await database.query(
            `SELECT seq_start, seq_end, turn_json FROM agenetes_turns
         WHERE extension_id=$1 AND thread_id=$2 AND ordinal >= $3 AND ordinal < $4
         ORDER BY ordinal`,
            [extensionId, threadId, lower, end],
          )
        ).rows.map((row) => ({
          seqStart: Number(row.seq_start),
          seqEnd: Number(row.seq_end),
          turn: JSON.parse(row.turn_json) as PersistedTurn['turn'],
        }));
        return {
          groups: groupPersistedTurns(threadId, generation, persisted, lower),
          next: encodeTurnCursor({
            version: 1,
            threadId,
            generation,
            ordinal: end,
          }),
          ...(hasMore
            ? {
                before: encodeTurnCursor({
                  version: 1,
                  threadId,
                  generation,
                  ordinal: lower,
                }),
              }
            : {}),
          hasMore,
        };
      },
    );
  }

  async count(namespace: Namespace, threadId: string): Promise<number> {
    return read(namespace, 0, async (db, id) =>
      Number(
        (
          await db.query(
            'SELECT COUNT(*) AS count FROM agenetes_turns WHERE extension_id=$1 AND thread_id=$2',
            [id, threadId],
          )
        ).rows[0].count,
      ),
    );
  }
  async fence(namespace: Namespace, threadId: string): Promise<number> {
    return read(namespace, 0, async (db, id) =>
      Number(
        (
          await db.query(
            'SELECT seq_end FROM agenetes_turns WHERE extension_id=$1 AND thread_id=$2 ORDER BY ordinal DESC LIMIT 1',
            [id, threadId],
          )
        ).rows[0]?.seq_end ?? 0,
      ),
    );
  }
  async replace(
    namespace: Namespace,
    threadId: string,
    records: readonly PersistedTurn[],
  ): Promise<void> {
    await mutate(namespace, threadId, async (db, id) => {
      await db.query(
        'DELETE FROM agenetes_turns WHERE extension_id=$1 AND thread_id=$2',
        [id, threadId],
      );
      await this.#bumpGeneration(db, id, threadId);
      for (const [index, row] of records.entries())
        await db.query(
          'INSERT INTO agenetes_turns VALUES ($1,$2,$3,$4,$5,$6)',
          [
            id,
            threadId,
            index + 1,
            row.seqStart,
            row.seqEnd,
            JSON.stringify(row.turn),
          ],
        );
    });
  }
  async delete(namespace: Namespace, threadId: string): Promise<void> {
    if (!(await substrate(namespace))) return;
    await mutate(namespace, threadId, async (db, id) => {
      await db.query(
        'DELETE FROM agenetes_turns WHERE extension_id=$1 AND thread_id=$2',
        [id, threadId],
      );
      await this.#bumpGeneration(db, id, threadId);
    });
  }
}
