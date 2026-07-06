// The durable side of the instance — the I9.4 query surface's backing.
//
// The instance exposes two orthogonal surfaces (README I9.3 / I9.4): the
// imperative *runtime surface* owns *live* {@link AgentHandle}s (backed by
// the `@agenetes/runtime` live-handle table), and this *query surface*
// reads the *durable records* Agenetes owns, addressed by
// `(namespace, threadId)` (I4). The two are deliberately orthogonal — a
// record read never requires a live handle, and a control write never
// lazily spawns one.
//
// This module defines the storage *port* only; it stays host-agnostic. The
// confirmed durable backing today is the ACP session store (I9.4), but
// that adapter is ACP-coupled and lives outside this core: a host wires an
// ACP-backed {@link ThreadStore} at composition time (M5 E2). The
// in-memory default here keeps the instance self-contained and unit
// testable, and documents the shape migrated code plugs into.

import type { Namespace } from '@agenetes/protocol';

/**
 * The durable, restart-surviving state Agenetes keeps for one thread —
 * the "persistent" half of a thread-table entry, held independently of
 * whether a live handle exists (I9.4).
 *
 * Placeholder: today it pins only the namespace `storage` root the thread
 * persists under. It grows the low-level `sessionId` (I4.3) and the
 * last-known agent metadata snapshot as M5.5 migrates the ACP session
 * record in behind the {@link ThreadStore} port.
 */
export class AgentPersistentState {
  /**
   * Absolute root this thread's L2 state persists under, derived from its
   * namespace's `storage.root` (I4.1). `undefined` when the namespace
   * supplied no storage (L2 falls back to its own default location).
   */
  readonly storageRoot: string | undefined;

  constructor(storageRoot: string | undefined) {
    this.storageRoot = storageRoot;
  }
}

/**
 * One entry of the per-namespace persistent thread table: the durable
 * `spec` baked at `create` (I9.6, opaque and serializable) plus the
 * {@link AgentPersistentState} Agenetes keeps alongside it.
 */
export interface ThreadRecord<TSpec = unknown> {
  /** The workload spec this thread was created from (durable, opaque). */
  readonly spec: TSpec;
  /** Agenetes-owned durable state, independent of any live handle. */
  readonly state: AgentPersistentState;
}

/**
 * The durable thread-record store the query surface reads — a per-namespace
 * `(namespace, threadId) → ThreadRecord` table (I9.4). Kept a narrow port
 * so the ACP-session-store-backed implementation (M5 E2) and this in-memory
 * default are interchangeable. Synchronous today (the ACP store's on-disk
 * reads are synchronous); an async variant can layer on later.
 */
export interface ThreadStore {
  /** Insert or replace the record for `(namespace, threadId)`. */
  upsert<TSpec>(
    namespace: Namespace,
    threadId: string,
    record: ThreadRecord<TSpec>,
  ): void;
  /** Read one record, or `undefined` when none is persisted. */
  get<TSpec = unknown>(
    namespace: Namespace,
    threadId: string,
  ): ThreadRecord<TSpec> | undefined;
  /** Enumerate every persisted record in a namespace. */
  list<TSpec = unknown>(namespace: Namespace): ThreadRecord<TSpec>[];
  /** Forget the record for `(namespace, threadId)`. Idempotent. */
  delete(namespace: Namespace, threadId: string): void;
}

/**
 * A process-local {@link ThreadStore} keyed by `namespace.name` — the
 * self-contained default so the instance needs no host wiring to run (and
 * unit tests need no disk). It does NOT survive a restart; the durable,
 * restart-surviving backing is the injected ACP-session-store adapter
 * (M5 E2). Namespaces are isolated: records never leak across `name`.
 */
export class InMemoryThreadStore implements ThreadStore {
  readonly #byNamespace = new Map<string, Map<string, ThreadRecord>>();

  #scope(namespace: Namespace): Map<string, ThreadRecord> {
    let scope = this.#byNamespace.get(namespace.name);
    if (!scope) {
      scope = new Map();
      this.#byNamespace.set(namespace.name, scope);
    }
    return scope;
  }

  upsert<TSpec>(
    namespace: Namespace,
    threadId: string,
    record: ThreadRecord<TSpec>,
  ): void {
    this.#scope(namespace).set(threadId, record as ThreadRecord);
  }

  get<TSpec = unknown>(
    namespace: Namespace,
    threadId: string,
  ): ThreadRecord<TSpec> | undefined {
    return this.#byNamespace.get(namespace.name)?.get(threadId) as
      | ThreadRecord<TSpec>
      | undefined;
  }

  list<TSpec = unknown>(namespace: Namespace): ThreadRecord<TSpec>[] {
    const scope = this.#byNamespace.get(namespace.name);
    return scope ? ([...scope.values()] as ThreadRecord<TSpec>[]) : [];
  }

  delete(namespace: Namespace, threadId: string): void {
    this.#byNamespace.get(namespace.name)?.delete(threadId);
  }
}
