// Tier 2 of the two-tier conversation log (README I9.8 / proposal M5.6) —
// the coarse, append-only log of folded `AgentTurn`s.
//
// The instance owns a two-tier conversation log per `(namespace, threadId)`
// (README I9.8). This module is TIER 2: on every `run()` return the
// instance folds the turn's Tier-1 event range plus the run's return
// transcript into one immutable {@link AgentTurn} and appends it here. It
// is the checkpoint layer — `history()` reads it back as the durable
// conversation, driver-agnostic and seq-free (I9.8).
//
// Each persisted record additionally pins the turn to its Tier-1 range via
// `seqStart..seqEnd`. That fence is the internal cursor the history
// materializer and `tail()` use to read the uncovered Tier-1 suffix. It is
// L2-INTERNAL bookkeeping and never leaves this package.
//
// Like {@link ThreadStore} and {@link EventLogStore}, this ships a storage
// PORT plus two host-agnostic implementations — {@link InMemoryTurnStore}
// (the self-contained default, so the instance runs without host wiring and
// unit tests need no disk) and {@link FileTurnStore} (the restart-surviving
// Disk backing, one Space-owned `chat_v2/turns.sqlite` with lazy import of
// the former per-thread JSONL files).

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { readJsonLines, sanitizeId } from './io.js';

import type { AgentTurn, Namespace } from '@agenetes/protocol';

/**
 * One persisted Tier-2 record: the folded {@link AgentTurn} plus the
 * inclusive `seqStart..seqEnd` range pinning it to its Tier-1 records,
 * beginning with `turn_start` and followed by zero or more event records.
 * Legacy/imported turns with no corresponding Tier-1 records may use an
 * empty range (`seqStart > seqEnd`). The fence is L2-internal.
 */
export interface PersistedTurn {
  /** The folded, immutable turn record (the only thing `history` exposes). */
  readonly turn: AgentTurn;
  /** First Tier-1 record this turn covers, normally its `turn_start`. */
  readonly seqStart: number;
  /** Last Tier-1 `seq` this turn covers — the fence for the next tail. */
  readonly seqEnd: number;
}

export interface TurnStorePageOptions {
  readonly limit: number;
  readonly before?: string;
}

export interface PersistedTurnGroup {
  readonly id: string;
  readonly turns: PersistedTurn[];
}

export interface TurnStorePage {
  readonly groups: PersistedTurnGroup[];
  /** Stable identity/cursor of the next append position at read time. */
  readonly next: string;
  readonly before?: string;
  readonly hasMore: boolean;
}

export class MalformedTurnCursorError extends Error {
  override name = 'MalformedTurnCursorError';
}

export class StaleTurnCursorError extends Error {
  override name = 'StaleTurnCursorError';
}

export interface TurnCursor {
  readonly version: 1;
  readonly threadId: string;
  readonly generation: number;
  readonly ordinal: number;
}

export function encodeTurnCursor(cursor: TurnCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeTurnCursor(value: string, threadId: string): TurnCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const cursor = parsed as Partial<TurnCursor>;
    if (
      cursor.version !== 1 ||
      cursor.threadId !== threadId ||
      !Number.isSafeInteger(cursor.generation) ||
      !Number.isSafeInteger(cursor.ordinal) ||
      (cursor.generation ?? 0) < 1 ||
      (cursor.ordinal ?? 0) < 1
    ) {
      throw new Error();
    }
    return cursor as TurnCursor;
  } catch {
    throw new MalformedTurnCursorError('Malformed history cursor');
  }
}

export function requireTurnPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('History page limit must be a positive integer');
  }
}

export function groupPersistedTurns(
  threadId: string,
  generation: number,
  turns: readonly PersistedTurn[],
  startOrdinal = 1,
): Array<PersistedTurnGroup & { readonly ordinal: number }> {
  const groups: Array<
    PersistedTurnGroup & { readonly ordinal: number; turns: PersistedTurn[] }
  > = [];
  turns.forEach((persisted, index) => {
    const ordinal = startOrdinal + index;
    if (persisted.turn.request !== null || groups.length === 0) {
      groups.push({
        id: encodeTurnCursor({
          version: 1,
          threadId,
          generation,
          ordinal,
        }),
        ordinal,
        turns: [persisted],
      });
    } else {
      groups[groups.length - 1]!.turns.push(persisted);
    }
  });
  return groups;
}

/**
 * The durable Tier-2 turn store — a per-`(namespace, threadId)` append-only
 * sequence of {@link PersistedTurn}s (I9.8). Kept a narrow port, exactly
 * like {@link ThreadStore} / {@link EventLogStore}, so the in-memory default
 * and the on-disk backing are interchangeable and a host injects the Disk
 * variant at mount. Synchronous today (mirrors its siblings).
 */
export interface TurnStore {
  /** Append one folded turn record to the thread's Tier-2 log. */
  append(
    namespace: Namespace,
    threadId: string,
    persisted: PersistedTurn,
  ): void;
  /** Read every folded turn for a thread, in fold (emission) order. */
  list(namespace: Namespace, threadId: string): PersistedTurn[];
  /** Read bounded display-turn groups immediately before an opaque cursor. */
  page(
    namespace: Namespace,
    threadId: string,
    options: TurnStorePageOptions,
  ): TurnStorePage;
  /** The number of folded turns persisted for a thread. */
  count(namespace: Namespace, threadId: string): number;
  /**
   * The `seqEnd` of the last folded turn — the Tier-1 fence a live tail
   * resumes from — or `0` when the thread has no folded turn yet (tail from
   * the very first event).
   */
  fence(namespace: Namespace, threadId: string): number;
  /**
   * Overwrite a thread's ENTIRE Tier-2 log with `persisted` (already in fold
   * order), replacing whatever the target held before. A narrow capability
   * reserved for the `rehome()` durable-move primitive — it writes the
   * destination turn log wholesale from a source snapshot, never for
   * incremental folds (those stay on `append`).
   */
  replace(
    namespace: Namespace,
    threadId: string,
    persisted: readonly PersistedTurn[],
  ): void;
  /**
   * Remove a thread's Tier-2 log entirely (idempotent). Reserved for the
   * `rehome()` primitive: dropping the source log after its target twin is
   * durable, or compensating a target log written during a failed rehome.
   */
  delete(namespace: Namespace, threadId: string): void;
}

/** Defensive shape-check for a persisted record read back from disk. */
function isPersistedTurn(value: unknown): value is PersistedTurn {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<PersistedTurn>;
  return (
    typeof r.seqStart === 'number' &&
    typeof r.seqEnd === 'number' &&
    typeof r.turn === 'object' &&
    r.turn !== null
  );
}

/**
 * A process-local {@link TurnStore} keyed by `namespace.name` — the
 * self-contained default so the instance needs no host wiring to run (and
 * unit tests need no disk). It does NOT survive a restart; the durable,
 * restart-surviving Disk backing is {@link FileTurnStore}. Namespaces are
 * isolated: turns never leak across `name`.
 */
export class InMemoryTurnStore implements TurnStore {
  readonly #byNamespace = new Map<string, Map<string, PersistedTurn[]>>();
  readonly #generations = new Map<string, number>();

  #scope(namespace: Namespace): Map<string, PersistedTurn[]> {
    let scope = this.#byNamespace.get(namespace.name);
    if (!scope) {
      scope = new Map();
      this.#byNamespace.set(namespace.name, scope);
    }
    return scope;
  }

  #log(namespace: Namespace, threadId: string): PersistedTurn[] {
    const scope = this.#scope(namespace);
    let log = scope.get(threadId);
    if (!log) {
      log = [];
      scope.set(threadId, log);
    }
    return log;
  }

  append(
    namespace: Namespace,
    threadId: string,
    persisted: PersistedTurn,
  ): void {
    this.#log(namespace, threadId).push(persisted);
  }

  list(namespace: Namespace, threadId: string): PersistedTurn[] {
    const log = this.#byNamespace.get(namespace.name)?.get(threadId);
    return log ? [...log] : [];
  }

  page(
    namespace: Namespace,
    threadId: string,
    options: TurnStorePageOptions,
  ): TurnStorePage {
    requireTurnPageLimit(options.limit);
    const key = `${namespace.name}\0${threadId}`;
    const generation = this.#generations.get(key) ?? 1;
    const log = this.#byNamespace.get(namespace.name)?.get(threadId) ?? [];
    const cursor = options.before
      ? decodeTurnCursor(options.before, threadId)
      : undefined;
    if (cursor && cursor.generation !== generation) {
      throw new StaleTurnCursorError('History cursor is stale');
    }
    const end = Math.min(cursor?.ordinal ?? log.length + 1, log.length + 1);
    const all = groupPersistedTurns(
      threadId,
      generation,
      log.slice(0, end - 1),
    );
    const groups = all.slice(-options.limit);
    const hasMore = all.length > groups.length;
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
              ordinal: groups[0]!.ordinal,
            }),
          }
        : {}),
      hasMore,
    };
  }

  count(namespace: Namespace, threadId: string): number {
    return this.#byNamespace.get(namespace.name)?.get(threadId)?.length ?? 0;
  }

  fence(namespace: Namespace, threadId: string): number {
    const log = this.#byNamespace.get(namespace.name)?.get(threadId);
    return log && log.length > 0 ? log[log.length - 1]!.seqEnd : 0;
  }

  replace(
    namespace: Namespace,
    threadId: string,
    persisted: readonly PersistedTurn[],
  ): void {
    const key = `${namespace.name}\0${threadId}`;
    this.#generations.set(key, (this.#generations.get(key) ?? 1) + 1);
    this.#scope(namespace).set(threadId, [...persisted]);
  }

  delete(namespace: Namespace, threadId: string): void {
    const key = `${namespace.name}\0${threadId}`;
    this.#generations.set(key, (this.#generations.get(key) ?? 1) + 1);
    this.#byNamespace.get(namespace.name)?.delete(threadId);
  }
}

/**
 * The restart-surviving Disk {@link TurnStore}. One Space owns one
 * `<namespace.storage.root>/chat_v2/turns.sqlite`; threads are rows, so a
 * history page reads only its requested range. Existing per-thread JSONL logs
 * are imported lazily and transactionally, then retired to `.bak`.
 */
export class FileTurnStore implements TurnStore {
  readonly #databases = new Map<string, DatabaseSync>();
  readonly #rename: (from: string, to: string) => void;

  constructor(options: { rename?: (from: string, to: string) => void } = {}) {
    this.#rename = options.rename ?? renameSync;
  }

  /** Close the Space-owned database so its directory can be renamed or removed. */
  close(namespace: Namespace): void {
    const filename = path.join(
      this.#root(namespace),
      'chat_v2',
      'turns.sqlite',
    );
    const database = this.#databases.get(filename);
    if (!database) return;
    database.close();
    this.#databases.delete(filename);
  }

  #root(namespace: Namespace): string {
    return (
      namespace.storage?.root ??
      `${process.cwd()}/.agenetes/namespaces/${sanitizeId(namespace.name, 'namespace')}`
    );
  }

  #database(namespace: Namespace): DatabaseSync {
    const filename = path.join(
      this.#root(namespace),
      'chat_v2',
      'turns.sqlite',
    );
    const cached = this.#databases.get(filename);
    if (cached) return cached;
    mkdirSync(path.dirname(filename), { recursive: true });
    const database = new DatabaseSync(filename);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS turns (
        thread_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        seq_start INTEGER NOT NULL,
        seq_end INTEGER NOT NULL,
        turn_json TEXT NOT NULL CHECK (json_valid(turn_json)),
        PRIMARY KEY (thread_id, ordinal)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turn_generations (
        thread_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS jsonl_imports (
        thread_id TEXT PRIMARY KEY
      ) STRICT;
    `);
    this.#databases.set(filename, database);
    return database;
  }

  #legacyPath(namespace: Namespace, threadId: string): string {
    sanitizeId(threadId, 'threadId');
    return path.join(
      this.#root(namespace),
      'chat_v2',
      `${threadId}.turns.jsonl`,
    );
  }

  #prepare(namespace: Namespace, threadId: string): DatabaseSync {
    const database = this.#database(namespace);
    const source = this.#legacyPath(namespace, threadId);
    const imported = database
      .prepare('SELECT 1 FROM jsonl_imports WHERE thread_id = ?')
      .get(threadId);
    if (imported !== undefined && !existsSync(source)) return database;
    const records = readJsonLines<unknown>(source).filter(isPersistedTurn);
    if (imported === undefined && records.length === 0) {
      try {
        this.#rename(source, `${source}.bak`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return database;
      }
      database
        .prepare('INSERT INTO jsonl_imports (thread_id) VALUES (?)')
        .run(threadId);
      return database;
    }
    if (imported === undefined) {
      database.exec('SAVEPOINT import_turn_jsonl');
      try {
        const existing = this.#count(database, threadId);
        if (existing !== 0) {
          throw new Error(
            `Cannot import JSONL for non-empty thread ${JSON.stringify(threadId)}`,
          );
        }
        const insert = database.prepare(
          `INSERT INTO turns
             (thread_id, ordinal, seq_start, seq_end, turn_json)
           VALUES (?, ?, ?, ?, ?)`,
        );
        records.forEach((record, index) => {
          insert.run(
            threadId,
            index + 1,
            record.seqStart,
            record.seqEnd,
            JSON.stringify(record.turn),
          );
        });
        database
          .prepare(
            `INSERT OR IGNORE INTO turn_generations
               (thread_id, generation) VALUES (?, 1)`,
          )
          .run(threadId);
        database
          .prepare('INSERT INTO jsonl_imports (thread_id) VALUES (?)')
          .run(threadId);
        database.exec('RELEASE SAVEPOINT import_turn_jsonl');
      } catch (error) {
        database.exec('ROLLBACK TO SAVEPOINT import_turn_jsonl');
        database.exec('RELEASE SAVEPOINT import_turn_jsonl');
        throw error;
      }
    }
    this.#rename(source, `${source}.bak`);
    return database;
  }

  #generation(database: DatabaseSync, threadId: string): number {
    database
      .prepare(
        `INSERT OR IGNORE INTO turn_generations
           (thread_id, generation) VALUES (?, 1)`,
      )
      .run(threadId);
    return Number(
      database
        .prepare('SELECT generation FROM turn_generations WHERE thread_id = ?')
        .get(threadId)?.['generation'],
    );
  }

  #count(database: DatabaseSync, threadId: string): number {
    return Number(
      database
        .prepare('SELECT COUNT(*) AS count FROM turns WHERE thread_id = ?')
        .get(threadId)?.['count'] ?? 0,
    );
  }

  append(
    namespace: Namespace,
    threadId: string,
    persisted: PersistedTurn,
  ): void {
    const database = this.#prepare(namespace, threadId);
    const ordinal = Number(
      database
        .prepare(
          'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM turns WHERE thread_id = ?',
        )
        .get(threadId)?.['ordinal'],
    );
    this.#generation(database, threadId);
    database
      .prepare(
        `INSERT INTO turns
           (thread_id, ordinal, seq_start, seq_end, turn_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        ordinal,
        persisted.seqStart,
        persisted.seqEnd,
        JSON.stringify(persisted.turn),
      );
  }

  list(namespace: Namespace, threadId: string): PersistedTurn[] {
    const database = this.#prepare(namespace, threadId);
    return database
      .prepare(
        `SELECT seq_start, seq_end, turn_json FROM turns
         WHERE thread_id = ? ORDER BY ordinal`,
      )
      .all(threadId)
      .map((row) => ({
        turn: JSON.parse(String(row['turn_json'])) as AgentTurn,
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
    const database = this.#prepare(namespace, threadId);
    const generation = this.#generation(database, threadId);
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
            'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM turns WHERE thread_id = ?',
          )
          .get(threadId)?.['ordinal'],
      );
    const starts = database
      .prepare(
        `SELECT ordinal FROM turns
         WHERE thread_id = ? AND ordinal < ?
           AND json_type(turn_json, '$.request') != 'null'
         ORDER BY ordinal DESC LIMIT ?`,
      )
      .all(threadId, end, options.limit + 1)
      .map((row) => Number(row['ordinal']));
    const first = database
      .prepare(
        `SELECT ordinal, json_type(turn_json, '$.request') AS request_type
         FROM turns WHERE thread_id = ? AND ordinal < ?
         ORDER BY ordinal LIMIT 1`,
      )
      .get(threadId, end);
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
        `SELECT ordinal, seq_start, seq_end, turn_json FROM turns
         WHERE thread_id = ? AND ordinal >= ? AND ordinal < ?
         ORDER BY ordinal`,
      )
      .all(threadId, lower, end);
    const persisted = rows.map((row) => ({
      turn: JSON.parse(String(row['turn_json'])) as AgentTurn,
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
    return this.#count(this.#prepare(namespace, threadId), threadId);
  }

  fence(namespace: Namespace, threadId: string): number {
    return Number(
      this.#prepare(namespace, threadId)
        .prepare(
          `SELECT seq_end FROM turns WHERE thread_id = ?
           ORDER BY ordinal DESC LIMIT 1`,
        )
        .get(threadId)?.['seq_end'] ?? 0,
    );
  }

  replace(
    namespace: Namespace,
    threadId: string,
    persisted: readonly PersistedTurn[],
  ): void {
    const database = this.#prepare(namespace, threadId);
    const encoded = persisted.map((record) => ({
      ...record,
      json: JSON.stringify(record.turn),
    }));
    database.exec('SAVEPOINT replace_turn_log');
    try {
      database.prepare('DELETE FROM turns WHERE thread_id = ?').run(threadId);
      database
        .prepare(
          `INSERT INTO turn_generations (thread_id, generation) VALUES (?, 2)
           ON CONFLICT(thread_id) DO UPDATE SET generation = generation + 1`,
        )
        .run(threadId);
      const insert = database.prepare(
        `INSERT INTO turns
           (thread_id, ordinal, seq_start, seq_end, turn_json)
         VALUES (?, ?, ?, ?, ?)`,
      );
      encoded.forEach((record, index) => {
        insert.run(
          threadId,
          index + 1,
          record.seqStart,
          record.seqEnd,
          record.json,
        );
      });
      database.exec('RELEASE SAVEPOINT replace_turn_log');
    } catch (error) {
      database.exec('ROLLBACK TO SAVEPOINT replace_turn_log');
      database.exec('RELEASE SAVEPOINT replace_turn_log');
      throw error;
    }
  }

  delete(namespace: Namespace, threadId: string): void {
    const database = this.#prepare(namespace, threadId);
    database.exec('SAVEPOINT delete_turn_log');
    try {
      database.prepare('DELETE FROM turns WHERE thread_id = ?').run(threadId);
      database
        .prepare(
          `INSERT INTO turn_generations (thread_id, generation) VALUES (?, 2)
           ON CONFLICT(thread_id) DO UPDATE SET generation = generation + 1`,
        )
        .run(threadId);
      database.exec('RELEASE SAVEPOINT delete_turn_log');
    } catch (error) {
      database.exec('ROLLBACK TO SAVEPOINT delete_turn_log');
      database.exec('RELEASE SAVEPOINT delete_turn_log');
      throw error;
    }
  }
}

// The folded turn's typed shape is re-exported for callers assembling a
// PersistedTurn without importing the protocol package directly.
export type { AgentTurn };
