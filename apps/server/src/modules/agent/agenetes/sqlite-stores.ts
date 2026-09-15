// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Agenetes conversation stores, for a Space that lives in SQLite.
 *
 * Agenetes ships three narrow storage ports — the durable thread table, the
 * Tier-1 event log, and the Tier-2 folded turn log — plus an in-memory and a
 * file implementation of each. A host picks. On Disk we pick the file ones and
 * they write under the Space's `.history/`. Where a Space is rows there is no
 * such directory, and the honest choice is not "in memory": a conversation
 * that vanishes on restart is a worse answer than the one this file gives.
 *
 * These are the storage proposal's §6.4.4 arrangement in practice. The port
 * hands over a *place* — a connection plus a Space-owned parent row — and the
 * owner brings its own tables and its own queries. Every table below hangs off
 * `space_extensions` with `ON DELETE CASCADE`, so deleting a Space takes its
 * conversations with it without storage knowing what a conversation is, and
 * without this module knowing where a Space is stored.
 *
 * The ports are synchronous, which is why they reach for `sqliteTree` rather
 * than the async `extension()`: `node:sqlite` is synchronous all the way down,
 * so nothing is lost by saying so.
 */

import {
  decodeTurnCursor,
  encodeTurnCursor,
  groupPersistedTurns,
  requireTurnPageLimit,
  StaleTurnCursorError,
} from '@agenetes/agenetes';

import { space } from '../../storage/index.js';

import type { SqliteSpaceSubstrate } from '../../storage/index.js';
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
import type { DatabaseSync } from 'node:sqlite';

/**
 * One namespace for all three stores.
 *
 * They are one owner — the conversation — split into three ports for reasons
 * that belong to Agenetes, not to storage. Giving each its own namespace would
 * buy three parent rows and no isolation that matters.
 */
const CONVERSATION_NAMESPACE = 'agenetes.conversations';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agenetes_threads (
    extension_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    PRIMARY KEY (extension_id, thread_id),
    FOREIGN KEY (extension_id) REFERENCES space_extensions(extension_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS agenetes_events (
    extension_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    PRIMARY KEY (extension_id, thread_id, seq),
    FOREIGN KEY (extension_id) REFERENCES space_extensions(extension_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS agenetes_turns (
    extension_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    seq_start INTEGER NOT NULL,
    seq_end INTEGER NOT NULL,
    turn_json TEXT NOT NULL CHECK (json_valid(turn_json)),
    PRIMARY KEY (extension_id, thread_id, ordinal),
    FOREIGN KEY (extension_id) REFERENCES space_extensions(extension_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS agenetes_turn_generations (
    extension_id INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    PRIMARY KEY (extension_id, thread_id),
    FOREIGN KEY (extension_id) REFERENCES space_extensions(extension_id)
      ON DELETE CASCADE
  ) STRICT;
`;

/** Namespaces whose tables have been created on this connection. */
const prepared = new WeakSet<DatabaseSync>();

/**
 * The place this Space's conversations live, or `null` when there is none.
 *
 * `null` covers three ordinary situations that all mean the same thing to a
 * caller: the profile is not SQLite, the namespace has no Space (an unnamed
 * Agenetes namespace), or the Space has been deleted.
 */
export function conversationTables(
  namespace: Namespace,
): SqliteSpaceSubstrate | null {
  if (!namespace.name) return null;
  const tree = space(namespace.name).sqliteTree;
  if (!tree) return null;
  const substrate = tree.extension(CONVERSATION_NAMESPACE);
  if (!substrate) return null;
  if (!prepared.has(substrate.database)) {
    substrate.database.exec(SCHEMA);
    prepared.add(substrate.database);
  }
  return substrate;
}

function encode(value: unknown, what: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError(`${what} is not representable as JSON`);
  }
  return encoded;
}

/** A replacement either installs the complete log or leaves the old one intact. */
function replaceLogAtomically(
  database: DatabaseSync,
  replace: () => void,
): void {
  // A savepoint gives this batch its own rollback boundary without committing
  // or rejecting an enclosing transaction.
  database.exec('SAVEPOINT agenetes_log_replace');
  try {
    replace();
    database.exec('RELEASE SAVEPOINT agenetes_log_replace');
  } catch (error) {
    if (database.isTransaction) {
      database.exec('ROLLBACK TO SAVEPOINT agenetes_log_replace');
      database.exec('RELEASE SAVEPOINT agenetes_log_replace');
    }
    throw error;
  }
}

function decode<T>(value: unknown, what: string): T {
  if (typeof value !== 'string') {
    throw new SyntaxError(`${what} is not stored as JSON text`);
  }
  return JSON.parse(value) as T;
}

function requireSubstrate(namespace: Namespace): SqliteSpaceSubstrate {
  const substrate = conversationTables(namespace);
  if (!substrate) {
    throw new Error(
      `No SQLite conversation store for namespace ${JSON.stringify(namespace.name)}`,
    );
  }
  return substrate;
}

export class SqliteThreadStore implements ThreadStore {
  upsert(namespace: Namespace, threadId: string, record: ThreadRecord): void {
    const { database, extensionId } = requireSubstrate(namespace);
    database
      .prepare(
        `INSERT INTO agenetes_threads (extension_id, thread_id, record_json)
         VALUES (?, ?, ?)
         ON CONFLICT(extension_id, thread_id) DO UPDATE SET
           record_json = excluded.record_json`,
      )
      .run(extensionId, threadId, encode(record, `Thread ${threadId}`));
  }

  get(namespace: Namespace, threadId: string): ThreadRecord | undefined {
    const substrate = conversationTables(namespace);
    if (!substrate) return undefined;
    const row = substrate.database
      .prepare(
        `SELECT record_json FROM agenetes_threads
         WHERE extension_id = ? AND thread_id = ?`,
      )
      .get(substrate.extensionId, threadId);
    return row === undefined
      ? undefined
      : decode<ThreadRecord>(row['record_json'], `Thread ${threadId}`);
  }

  list(namespace: Namespace): ThreadRecord[] {
    const substrate = conversationTables(namespace);
    if (!substrate) return [];
    return substrate.database
      .prepare(
        `SELECT thread_id, record_json FROM agenetes_threads
         WHERE extension_id = ?
         ORDER BY thread_id`,
      )
      .all(substrate.extensionId)
      .map((row) =>
        decode<ThreadRecord>(
          row['record_json'],
          `Thread ${String(row['thread_id'])}`,
        ),
      );
  }

  delete(namespace: Namespace, threadId: string): void {
    const substrate = conversationTables(namespace);
    if (!substrate) return;
    substrate.database
      .prepare(
        `DELETE FROM agenetes_threads
         WHERE extension_id = ? AND thread_id = ?`,
      )
      .run(substrate.extensionId, threadId);
  }
}

export class SqliteEventLogStore implements EventLogStore {
  appendTurnStart(
    namespace: Namespace,
    threadId: string,
    request: AgentSubmission | null,
  ): TurnStartLogEntry {
    const entry: TurnStartLogEntry = {
      seq: this.maxSeq(namespace, threadId) + 1,
      ts: Date.now(),
      kind: 'turn_start' as const,
      request,
    };
    this.#insert(namespace, threadId, entry.seq, entry);
    return entry;
  }

  append(
    namespace: Namespace,
    threadId: string,
    event: EventLogEntry['event'],
  ): EventLogEntry {
    const entry: EventLogEntry = {
      seq: this.maxSeq(namespace, threadId) + 1,
      ts: Date.now(),
      event,
    };
    this.#insert(namespace, threadId, entry.seq, entry);
    return entry;
  }

  read(namespace: Namespace, threadId: string, sinceSeq = 0): EventLogEntry[] {
    return this.readRecords(namespace, threadId, sinceSeq).filter(
      (record): record is EventLogEntry => !('kind' in record),
    );
  }

  readRecords(
    namespace: Namespace,
    threadId: string,
    sinceSeq = 0,
  ): EventLogRecord[] {
    const substrate = conversationTables(namespace);
    if (!substrate) return [];
    return substrate.database
      .prepare(
        `SELECT record_json FROM agenetes_events
         WHERE extension_id = ? AND thread_id = ? AND seq > ?
         ORDER BY seq`,
      )
      .all(substrate.extensionId, threadId, sinceSeq)
      .map((row) =>
        decode<EventLogRecord>(
          row['record_json'],
          `Event log for thread ${threadId}`,
        ),
      );
  }

  maxSeq(namespace: Namespace, threadId: string): number {
    const substrate = conversationTables(namespace);
    if (!substrate) return 0;
    const value = substrate.database
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM agenetes_events
         WHERE extension_id = ? AND thread_id = ?`,
      )
      .get(substrate.extensionId, threadId)?.['max_seq'];
    return typeof value === 'number' ? value : 0;
  }

  replace(
    namespace: Namespace,
    threadId: string,
    records: readonly EventLogRecord[],
  ): void {
    const encoded = records.map((record) => ({
      seq: record.seq,
      json: encode(record, `Event log for thread ${threadId}`),
    }));
    const { database, extensionId } = requireSubstrate(namespace);
    replaceLogAtomically(database, () => {
      database
        .prepare(
          'DELETE FROM agenetes_events WHERE extension_id = ? AND thread_id = ?',
        )
        .run(extensionId, threadId);
      const insert = database.prepare(
        `INSERT INTO agenetes_events (extension_id, thread_id, seq, record_json)
         VALUES (?, ?, ?, ?)`,
      );
      for (const record of encoded) {
        insert.run(extensionId, threadId, record.seq, record.json);
      }
    });
  }

  delete(namespace: Namespace, threadId: string): void {
    const substrate = conversationTables(namespace);
    if (!substrate) return;
    substrate.database
      .prepare(
        'DELETE FROM agenetes_events WHERE extension_id = ? AND thread_id = ?',
      )
      .run(substrate.extensionId, threadId);
  }

  #insert(
    namespace: Namespace,
    threadId: string,
    seq: number,
    record: EventLogRecord,
  ): void {
    const { database, extensionId } = requireSubstrate(namespace);
    database
      .prepare(
        `INSERT INTO agenetes_events (extension_id, thread_id, seq, record_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        extensionId,
        threadId,
        seq,
        encode(record, `Event log for thread ${threadId}`),
      );
  }
}

export class SqliteTurnStore implements TurnStore {
  #generation(
    database: DatabaseSync,
    extensionId: number,
    threadId: string,
  ): number {
    database
      .prepare(
        `INSERT OR IGNORE INTO agenetes_turn_generations
           (extension_id, thread_id, generation) VALUES (?, ?, 1)`,
      )
      .run(extensionId, threadId);
    return Number(
      database
        .prepare(
          `SELECT generation FROM agenetes_turn_generations
           WHERE extension_id = ? AND thread_id = ?`,
        )
        .get(extensionId, threadId)?.['generation'],
    );
  }

  append(
    namespace: Namespace,
    threadId: string,
    persisted: PersistedTurn,
  ): void {
    const { database, extensionId } = requireSubstrate(namespace);
    this.#generation(database, extensionId, threadId);
    const ordinal = this.count(namespace, threadId) + 1;
    database
      .prepare(
        `INSERT INTO agenetes_turns (
           extension_id, thread_id, ordinal, seq_start, seq_end, turn_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        extensionId,
        threadId,
        ordinal,
        persisted.seqStart,
        persisted.seqEnd,
        encode(persisted.turn, `Turn for thread ${threadId}`),
      );
  }

  list(namespace: Namespace, threadId: string): PersistedTurn[] {
    const substrate = conversationTables(namespace);
    if (!substrate) return [];
    return substrate.database
      .prepare(
        `SELECT seq_start, seq_end, turn_json FROM agenetes_turns
         WHERE extension_id = ? AND thread_id = ?
         ORDER BY ordinal`,
      )
      .all(substrate.extensionId, threadId)
      .map((row) => ({
        turn: decode<PersistedTurn['turn']>(
          row['turn_json'],
          `Turn for thread ${threadId}`,
        ),
        seqStart: Number(row['seq_start']),
        seqEnd: Number(row['seq_end']),
      }));
  }

  page(
    namespace: Namespace,
    threadId: string,
    options: TurnStorePageOptions,
  ): TurnStorePage {
    requireTurnPageLimit(options.limit);
    const substrate = conversationTables(namespace);
    if (!substrate) {
      return {
        groups: [],
        next: encodeTurnCursor({
          version: 1,
          threadId,
          generation: 1,
          ordinal: 1,
        }),
        hasMore: false,
      };
    }
    const { database, extensionId } = substrate;
    const generation = this.#generation(database, extensionId, threadId);
    const cursor = options.before
      ? decodeTurnCursor(options.before, threadId)
      : undefined;
    if (cursor && cursor.generation !== generation) {
      throw new StaleTurnCursorError('History cursor is stale');
    }
    const end =
      cursor?.ordinal ??
      Number(
        database
          .prepare(
            `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
             FROM agenetes_turns
             WHERE extension_id = ? AND thread_id = ?`,
          )
          .get(extensionId, threadId)?.['ordinal'],
      );
    const starts = database
      .prepare(
        `SELECT ordinal FROM agenetes_turns
         WHERE extension_id = ? AND thread_id = ? AND ordinal < ?
           AND json_type(turn_json, '$.request') != 'null'
         ORDER BY ordinal DESC LIMIT ?`,
      )
      .all(extensionId, threadId, end, options.limit + 1)
      .map((row) => Number(row['ordinal']));
    const first = database
      .prepare(
        `SELECT ordinal, json_type(turn_json, '$.request') AS request_type
         FROM agenetes_turns
         WHERE extension_id = ? AND thread_id = ? AND ordinal < ?
         ORDER BY ordinal LIMIT 1`,
      )
      .get(extensionId, threadId, end);
    if (
      first &&
      first['request_type'] === 'null' &&
      starts.length <= options.limit
    ) {
      starts.push(Number(first['ordinal']));
    }
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
    const rows = database
      .prepare(
        `SELECT seq_start, seq_end, turn_json FROM agenetes_turns
         WHERE extension_id = ? AND thread_id = ?
           AND ordinal >= ? AND ordinal < ?
         ORDER BY ordinal`,
      )
      .all(extensionId, threadId, lower, end);
    const persisted = rows.map((row) => ({
      turn: decode<PersistedTurn['turn']>(
        row['turn_json'],
        `Turn for thread ${threadId}`,
      ),
      seqStart: Number(row['seq_start']),
      seqEnd: Number(row['seq_end']),
    }));
    const groups = groupPersistedTurns(threadId, generation, persisted, lower);
    return {
      groups,
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
  }

  count(namespace: Namespace, threadId: string): number {
    const substrate = conversationTables(namespace);
    if (!substrate) return 0;
    const value = substrate.database
      .prepare(
        `SELECT COUNT(*) AS turns FROM agenetes_turns
         WHERE extension_id = ? AND thread_id = ?`,
      )
      .get(substrate.extensionId, threadId)?.['turns'];
    return typeof value === 'number' ? value : 0;
  }

  fence(namespace: Namespace, threadId: string): number {
    const substrate = conversationTables(namespace);
    if (!substrate) return 0;
    const value = substrate.database
      .prepare(
        `SELECT seq_end FROM agenetes_turns
         WHERE extension_id = ? AND thread_id = ?
         ORDER BY ordinal DESC
         LIMIT 1`,
      )
      .get(substrate.extensionId, threadId)?.['seq_end'];
    return typeof value === 'number' ? value : 0;
  }

  replace(
    namespace: Namespace,
    threadId: string,
    persisted: readonly PersistedTurn[],
  ): void {
    const encoded = persisted.map((record) => ({
      seqStart: record.seqStart,
      seqEnd: record.seqEnd,
      json: encode(record.turn, `Turn for thread ${threadId}`),
    }));
    const { database, extensionId } = requireSubstrate(namespace);
    replaceLogAtomically(database, () => {
      database
        .prepare(
          'DELETE FROM agenetes_turns WHERE extension_id = ? AND thread_id = ?',
        )
        .run(extensionId, threadId);
      database
        .prepare(
          `INSERT INTO agenetes_turn_generations
             (extension_id, thread_id, generation) VALUES (?, ?, 2)
           ON CONFLICT(extension_id, thread_id) DO UPDATE SET
             generation = generation + 1`,
        )
        .run(extensionId, threadId);
      const insert = database.prepare(
        `INSERT INTO agenetes_turns (
           extension_id, thread_id, ordinal, seq_start, seq_end, turn_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      encoded.forEach((record, index) => {
        insert.run(
          extensionId,
          threadId,
          index + 1,
          record.seqStart,
          record.seqEnd,
          record.json,
        );
      });
    });
  }

  delete(namespace: Namespace, threadId: string): void {
    const substrate = conversationTables(namespace);
    if (!substrate) return;
    replaceLogAtomically(substrate.database, () => {
      substrate.database
        .prepare(
          'DELETE FROM agenetes_turns WHERE extension_id = ? AND thread_id = ?',
        )
        .run(substrate.extensionId, threadId);
      substrate.database
        .prepare(
          `INSERT INTO agenetes_turn_generations
             (extension_id, thread_id, generation) VALUES (?, ?, 2)
           ON CONFLICT(extension_id, thread_id) DO UPDATE SET
             generation = generation + 1`,
        )
        .run(substrate.extensionId, threadId);
    });
  }
}
