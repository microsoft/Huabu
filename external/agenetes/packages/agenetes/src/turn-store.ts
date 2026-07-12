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
// on-disk backing, one JSONL file per thread under the namespace's
// `chat_v2/` sub-dir, the folded twin of the Tier-1 `.events.jsonl`).

import { appendJsonLine, readJsonLines, sanitizeId } from './io.js';

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

/**
 * The durable Tier-2 turn store — a per-`(namespace, threadId)` append-only
 * sequence of {@link PersistedTurn}s (I9.8). Kept a narrow port, exactly
 * like {@link ThreadStore} / {@link EventLogStore}, so the in-memory default
 * and the on-disk backing are interchangeable and a host injects the file
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
  /** The number of folded turns persisted for a thread. */
  count(namespace: Namespace, threadId: string): number;
  /**
   * The `seqEnd` of the last folded turn — the Tier-1 fence a live tail
   * resumes from — or `0` when the thread has no folded turn yet (tail from
   * the very first event).
   */
  fence(namespace: Namespace, threadId: string): number;
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
 * restart-surviving backing is {@link FileTurnStore}. Namespaces are
 * isolated: turns never leak across `name`.
 */
export class InMemoryTurnStore implements TurnStore {
  readonly #byNamespace = new Map<string, Map<string, PersistedTurn[]>>();

  #log(namespace: Namespace, threadId: string): PersistedTurn[] {
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

  count(namespace: Namespace, threadId: string): number {
    return this.#byNamespace.get(namespace.name)?.get(threadId)?.length ?? 0;
  }

  fence(namespace: Namespace, threadId: string): number {
    const log = this.#byNamespace.get(namespace.name)?.get(threadId);
    return log && log.length > 0 ? log[log.length - 1]!.seqEnd : 0;
  }
}

/**
 * The restart-surviving {@link TurnStore} — the on-disk twin of
 * {@link InMemoryTurnStore}, persisting a thread's Tier-2 log as an
 * append-only JSONL file at
 * `<namespace.storage.root>/chat_v2/<threadId>.turns.jsonl` (one file per
 * thread), the folded sibling of the Tier-1 `<threadId>.events.jsonl`. The
 * shared `chat_v2/` sub-dir keeps the new two-tier log cleanly separate
 * from the host's legacy `<threadId>.turns.jsonl` at the namespace root, so
 * the writers never collide and the M6.9 migrator has an unambiguous
 * source→target mapping.
 *
 * Appends are O(one line) (`appendJsonLine`). Reads tolerate a missing /
 * partially-written file and skip any malformed line, so a corrupt tail
 * never bricks a read. `count` and `fence` share process-local metadata
 * seeded by the first file scan, so subsequent reads and appends are O(1).
 */
export class FileTurnStore implements TurnStore {
  readonly #metadataByPath = new Map<
    string,
    { readonly count: number; readonly fence: number }
  >();

  #path(namespace: Namespace, threadId: string): string {
    sanitizeId(threadId, 'threadId');
    const root =
      namespace.storage?.root ??
      // Dormant fallback for a namespace with no storage root (mirrors
      // FileThreadStore / FileEventLogStore) — hosts always supply an
      // explicit `storage.root`.
      `${process.cwd()}/.agenetes/namespaces/${sanitizeId(namespace.name, 'namespace')}`;
    return `${root}/chat_v2/${threadId}.turns.jsonl`;
  }

  append(
    namespace: Namespace,
    threadId: string,
    persisted: PersistedTurn,
  ): void {
    const filePath = this.#path(namespace, threadId);
    const metadata = this.#metadata(filePath);
    appendJsonLine(filePath, persisted);
    this.#metadataByPath.set(filePath, {
      count: metadata.count + 1,
      fence: persisted.seqEnd,
    });
  }

  list(namespace: Namespace, threadId: string): PersistedTurn[] {
    const filePath = this.#path(namespace, threadId);
    const log = this.#read(filePath);
    this.#metadataByPath.set(filePath, this.#metadataFor(log));
    return log;
  }

  count(namespace: Namespace, threadId: string): number {
    return this.#metadata(this.#path(namespace, threadId)).count;
  }

  fence(namespace: Namespace, threadId: string): number {
    return this.#metadata(this.#path(namespace, threadId)).fence;
  }

  #read(filePath: string): PersistedTurn[] {
    return readJsonLines<unknown>(filePath).filter(isPersistedTurn);
  }

  #metadata(filePath: string): { count: number; fence: number } {
    const cached = this.#metadataByPath.get(filePath);
    if (cached) return cached;
    const log = this.#read(filePath);
    const metadata = this.#metadataFor(log);
    this.#metadataByPath.set(filePath, metadata);
    return metadata;
  }

  #metadataFor(log: readonly PersistedTurn[]): {
    count: number;
    fence: number;
  } {
    return {
      count: log.length,
      fence: log[log.length - 1]?.seqEnd ?? 0,
    };
  }
}

// The folded turn's typed shape is re-exported for callers assembling a
// PersistedTurn without importing the protocol package directly.
export type { AgentTurn };
