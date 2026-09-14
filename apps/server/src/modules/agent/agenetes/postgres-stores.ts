// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Conversation tables remain owned by Agenetes, attached to storage's parent row. */
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
 turn_json TEXT NOT NULL CHECK ((turn_json::json) IS NOT NULL), PRIMARY KEY(extension_id, thread_id, ordinal));`;
const prepared = new WeakMap<Pool, Promise<void>>();
async function tables(database: Pool): Promise<void> {
  let pending = prepared.get(database);
  if (!pending) {
    pending = (async () => {
      const client = await database.connect();
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
async function mutate<T>(
  namespace: Namespace,
  threadId: string,
  operation: (database: PoolClient, id: number) => Promise<T>,
): Promise<T> {
  const value = await substrate(namespace);
  if (!value) throw new Error('Cannot persist conversation in a missing Space');
  const client = await value.database.connect();
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
  }
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
  async append(
    namespace: Namespace,
    threadId: string,
    record: PersistedTurn,
  ): Promise<void> {
    await mutate(namespace, threadId, async (db, id) => {
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
    });
  }
}
