// Tier 1 of the two-tier conversation log (README I9.8 / proposal M5.6) —
// the fine, append-only, monotonically-sequenced turn/event record log.
//
// The instance owns a two-tier conversation log per `(namespace, threadId)`
// (README I9.8). This module is TIER 1: `run(submission, ctx)` first appends an
// internal turn boundary carrying the submission in the legacy-named request
// field, then every yielded frame is
// appended as it streams. Tier 1 is the write-ahead / streaming layer:
//   - append-only + monotonically sequenced — never rewritten, renamed or
//     deleted, so it dissolves the host's fragile mutable draft slot and
//     makes the in-memory live buffer durable;
//   - the sequence number is the internal FENCE that pins a Tier-2 folded
//     `AgentTurn` to its Tier-1 event range, so live-tail reconnect and
//     crash-recovery are the same primitive (Tier 2 + the `history`/`tail`
//     surface land in C3).
//
// Like the durable {@link ThreadStore}, this ships a storage PORT plus two
// host-agnostic implementations — {@link InMemoryEventLogStore} (the
// self-contained default, so the instance runs without host wiring and unit
// tests need no disk) and {@link FileEventLogStore} (the restart-surviving
// on-disk backing, one JSONL file per thread under the namespace's
// `chat_v2/` sub-dir). {@link EventLog} wraps a store with a process-local
// pub/sub for live subscribers; the store handles durability, the wrapper
// handles the live fan-out. All of this is L2-internal — the sequence
// numbers, the pub/sub, and the file layout never leak to L1 (I9.8).

import { appendJsonLine, readJsonLines, sanitizeId } from './io.js';

import type {
  AgentSubmission,
  AgentStreamEvent,
  Namespace,
} from '@agenetes/protocol';

/**
 * One durable entry of a thread's Tier-1 event log: the appended
 * {@link AgentStreamEvent} plus its monotonic `seq` (1-based, per
 * `(namespace, threadId)`) and append timestamp. `seq` is the fence a
 * Tier-2 record pins to (I9.8) and the cursor `tail`/`read` resumes from.
 */
export interface EventLogEntry {
  /** Monotonic, 1-based sequence within the `(namespace, threadId)` log. */
  readonly seq: number;
  /** Epoch ms the entry was appended. */
  readonly ts: number;
  /** The streamed frame this entry durably records. */
  readonly event: AgentStreamEvent;
}

/**
 * Internal Tier-1 boundary written synchronously when `run(submission, ctx)`
 * begins. It carries the submission needed to project an uncovered event
 * tail as a complete read-time turn, but never enters the public event stream.
 */
export interface TurnStartLogEntry {
  /** Monotonic sequence shared with streamed event entries. */
  readonly seq: number;
  /** Epoch ms the turn began. */
  readonly ts: number;
  readonly kind: 'turn_start';
  readonly request: AgentSubmission | null;
}

/** Every durable Tier-1 record, including internal turn boundaries. */
export type EventLogRecord = EventLogEntry | TurnStartLogEntry;

/**
 * The durable Tier-1 log store — a per-`(namespace, threadId)` append-only
 * sequence of {@link EventLogRecord}s (I9.8). Kept a narrow
 * port, exactly like {@link ThreadStore}, so the in-memory default and the
 * on-disk backing are interchangeable and a host injects the file variant
 * at mount. Durability only — the live pub/sub is {@link EventLog}'s.
 * Synchronous today (mirrors {@link ThreadStore}); an async variant can
 * layer on later.
 */
export interface EventLogStore {
  /** Append the internal boundary for a newly-started turn. */
  appendTurnStart(
    namespace: Namespace,
    threadId: string,
    request: AgentSubmission | null,
  ): TurnStartLogEntry;
  /**
   * Append `event` to the thread's log, assigning the next `seq`
   * (`maxSeq + 1`). Returns the durable entry, whose `seq` is the fence for
   * any Tier-2 record folding up to it.
   */
  append(
    namespace: Namespace,
    threadId: string,
    event: AgentStreamEvent,
  ): EventLogEntry;
  /**
   * Read the log for a thread. With `sinceSeq` set, returns only entries
   * with `seq > sinceSeq` (the fence read that powers `tail` reconnect);
   * omitted / `0` returns the whole log.
   */
  read(
    namespace: Namespace,
    threadId: string,
    sinceSeq?: number,
  ): EventLogEntry[];
  /** Read both internal turn boundaries and streamed event entries. */
  readRecords(
    namespace: Namespace,
    threadId: string,
    sinceSeq?: number,
  ): EventLogRecord[];
  /** The highest `seq` persisted for a thread, or `0` when the log is empty. */
  maxSeq(namespace: Namespace, threadId: string): number;
}

/** Defensive shape-check for a persisted entry read back from disk. */
function isEntry(value: unknown): value is EventLogEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<EventLogEntry>;
  return (
    typeof e.seq === 'number' &&
    typeof e.ts === 'number' &&
    typeof e.event === 'object' &&
    e.event !== null
  );
}

/** Defensive shape-check for an internal turn boundary read from disk. */
function isTurnStartEntry(value: unknown): value is TurnStartLogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<TurnStartLogEntry>;
  return (
    entry.kind === 'turn_start' &&
    typeof entry.seq === 'number' &&
    typeof entry.ts === 'number' &&
    (entry.request === null ||
      (typeof entry.request === 'object' && entry.request !== null))
  );
}

function isRecord(value: unknown): value is EventLogRecord {
  return isEntry(value) || isTurnStartEntry(value);
}

/**
 * A process-local {@link EventLogStore} keyed by `namespace.name` — the
 * self-contained default so the instance needs no host wiring to run (and
 * unit tests need no disk). It does NOT survive a restart; the durable,
 * restart-surviving backing is {@link FileEventLogStore}. Namespaces are
 * isolated: logs never leak across `name`.
 */
export class InMemoryEventLogStore implements EventLogStore {
  readonly #byNamespace = new Map<string, Map<string, EventLogRecord[]>>();

  #log(namespace: Namespace, threadId: string): EventLogRecord[] {
    let scope = this.#byNamespace.get(namespace.name);
    if (!scope) {
      scope = new Map();
      this.#byNamespace.set(namespace.name, scope);
    }
    let log = scope.get(threadId);
    if (!log) {
      log = [];
      scope.set(threadId, log);
    }
    return log;
  }

  appendTurnStart(
    namespace: Namespace,
    threadId: string,
    request: AgentSubmission | null,
  ): TurnStartLogEntry {
    const log = this.#log(namespace, threadId);
    const entry: TurnStartLogEntry = {
      seq: (log[log.length - 1]?.seq ?? 0) + 1,
      ts: Date.now(),
      kind: 'turn_start',
      request,
    };
    log.push(entry);
    return entry;
  }

  append(
    namespace: Namespace,
    threadId: string,
    event: AgentStreamEvent,
  ): EventLogEntry {
    const log = this.#log(namespace, threadId);
    const seq = (log[log.length - 1]?.seq ?? 0) + 1;
    const entry: EventLogEntry = { seq, ts: Date.now(), event };
    log.push(entry);
    return entry;
  }

  read(namespace: Namespace, threadId: string, sinceSeq = 0): EventLogEntry[] {
    return this.readRecords(namespace, threadId, sinceSeq).filter(isEntry);
  }

  readRecords(
    namespace: Namespace,
    threadId: string,
    sinceSeq = 0,
  ): EventLogRecord[] {
    const log = this.#byNamespace.get(namespace.name)?.get(threadId);
    if (!log) return [];
    return sinceSeq > 0 ? log.filter((e) => e.seq > sinceSeq) : [...log];
  }

  maxSeq(namespace: Namespace, threadId: string): number {
    const log = this.#byNamespace.get(namespace.name)?.get(threadId);
    return log && log.length > 0 ? log[log.length - 1]!.seq : 0;
  }
}

/**
 * The restart-surviving {@link EventLogStore} — the on-disk twin of
 * {@link InMemoryEventLogStore}, persisting a thread's Tier-1 log as an
 * append-only JSONL file at
 * `<namespace.storage.root>/chat_v2/<threadId>.events.jsonl` (one file per
 * thread). The `chat_v2/` sub-dir keeps the new two-tier log cleanly
 * separate from the host's legacy `<threadId>.turns.jsonl` / `.active.json`
 * at the namespace root, so the writers never collide and the M6.9 migrator
 * has an unambiguous source→target mapping.
 *
 * Appends are O(one line) (`appendJsonLine`); the next `seq` is served from
 * a process-local per-file counter, seeded once by scanning the file's max
 * `seq`, so an append never re-reads the whole file. Reads tolerate a
 * missing / partially-written file and skip any malformed line, so a
 * corrupt tail never bricks a read.
 */
export class FileEventLogStore implements EventLogStore {
  /** `path → last assigned seq`, so `append` stays O(1) after the first. */
  readonly #seqByPath = new Map<string, number>();

  #path(namespace: Namespace, threadId: string): string {
    sanitizeId(threadId, 'threadId');
    const root =
      namespace.storage?.root ??
      // Dormant fallback for a namespace with no storage root (mirrors
      // FileThreadStore) — hosts always supply an explicit `storage.root`.
      `${process.cwd()}/.agenetes/namespaces/${sanitizeId(namespace.name, 'namespace')}`;
    return `${root}/chat_v2/${threadId}.events.jsonl`;
  }

  /** Seed / read the last-seq counter for a file by scanning it once. */
  #lastSeq(filePath: string): number {
    const cached = this.#seqByPath.get(filePath);
    if (cached !== undefined) return cached;
    let max = 0;
    for (const entry of readJsonLines<unknown>(filePath)) {
      if (isRecord(entry) && entry.seq > max) max = entry.seq;
    }
    this.#seqByPath.set(filePath, max);
    return max;
  }

  append(
    namespace: Namespace,
    threadId: string,
    event: AgentStreamEvent,
  ): EventLogEntry {
    const filePath = this.#path(namespace, threadId);
    const seq = this.#lastSeq(filePath) + 1;
    const entry: EventLogEntry = { seq, ts: Date.now(), event };
    appendJsonLine(filePath, entry);
    this.#seqByPath.set(filePath, seq);
    return entry;
  }

  appendTurnStart(
    namespace: Namespace,
    threadId: string,
    request: AgentSubmission | null,
  ): TurnStartLogEntry {
    const filePath = this.#path(namespace, threadId);
    const seq = this.#lastSeq(filePath) + 1;
    const entry: TurnStartLogEntry = {
      seq,
      ts: Date.now(),
      kind: 'turn_start',
      request,
    };
    appendJsonLine(filePath, entry);
    this.#seqByPath.set(filePath, seq);
    return entry;
  }

  read(namespace: Namespace, threadId: string, sinceSeq = 0): EventLogEntry[] {
    return this.readRecords(namespace, threadId, sinceSeq).filter(isEntry);
  }

  readRecords(
    namespace: Namespace,
    threadId: string,
    sinceSeq = 0,
  ): EventLogRecord[] {
    const records = readJsonLines<unknown>(
      this.#path(namespace, threadId),
    ).filter(isRecord);
    return sinceSeq > 0
      ? records.filter((entry) => entry.seq > sinceSeq)
      : records;
  }

  maxSeq(namespace: Namespace, threadId: string): number {
    return this.#lastSeq(this.#path(namespace, threadId));
  }
}

/** A live-tail subscriber: invoked for every entry appended after it subscribes. */
export type EventLogListener = (entry: EventLogEntry) => void;

/**
 * The instance's Tier-1 log handle: a durable {@link EventLogStore} plus a
 * process-local pub/sub for LIVE subscribers. `append` persists the entry
 * (durability) and THEN fans it out to current live subscribers (the live
 * tail), so a subscriber that first drains `read(sinceSeq)` and then
 * receives live entries observes a gap-free, duplicate-free sequence — the
 * fence the `tail` and history materializer compose on.
 *
 * The live fan-out is keyed by `threadId` alone: `threadId` is globally
 * unique (a host guarantee, I4.2), matching the threadId-keyed notification
 * bus. Durability stays namespace-partitioned via the store.
 */
export class EventLog {
  readonly #store: EventLogStore;
  readonly #listeners = new Map<string, Set<EventLogListener>>();

  constructor(store: EventLogStore) {
    this.#store = store;
  }

  /**
   * Persist a turn boundary without publishing it to live event
   * subscribers. Public tail consumers observe only AgentStreamEvents.
   */
  beginTurn(
    namespace: Namespace,
    threadId: string,
    request: AgentSubmission | null,
  ): TurnStartLogEntry {
    return this.#store.appendTurnStart(namespace, threadId, request);
  }

  /** Append + persist an event, then notify live subscribers of the thread. */
  append(
    namespace: Namespace,
    threadId: string,
    event: AgentStreamEvent,
  ): EventLogEntry {
    const entry = this.#store.append(namespace, threadId, event);
    const set = this.#listeners.get(threadId);
    if (set) {
      // Snapshot so a listener that unsubscribes during dispatch is safe.
      for (const listener of [...set]) listener(entry);
    }
    return entry;
  }

  /** Durable read (fence read when `sinceSeq` is set); see {@link EventLogStore.read}. */
  read(
    namespace: Namespace,
    threadId: string,
    sinceSeq?: number,
  ): EventLogEntry[] {
    return this.#store.read(namespace, threadId, sinceSeq);
  }

  /** Durable read of all Tier-1 records for history materialization. */
  readRecords(
    namespace: Namespace,
    threadId: string,
    sinceSeq?: number,
  ): EventLogRecord[] {
    return this.#store.readRecords(namespace, threadId, sinceSeq);
  }

  /** The highest persisted `seq` for a thread (the fence), or `0` when empty. */
  maxSeq(namespace: Namespace, threadId: string): number {
    return this.#store.maxSeq(namespace, threadId);
  }

  /**
   * Subscribe to entries appended AFTER this call for `threadId`. Returns an
   * idempotent unsubscribe. Backfill (entries already persisted) is the
   * caller's `read` concern — this delivers only the live tail.
   */
  subscribe(threadId: string, listener: EventLogListener): () => void {
    let set = this.#listeners.get(threadId);
    if (!set) {
      set = new Set();
      this.#listeners.set(threadId, set);
    }
    set.add(listener);
    return () => {
      const current = this.#listeners.get(threadId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(threadId);
    };
  }
}
