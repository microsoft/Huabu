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
// This module defines the storage *port* plus two implementations, both
// host-agnostic: {@link InMemoryThreadStore} (the self-contained default so
// the instance runs without host wiring and unit tests need no disk) and
// {@link FileThreadStore} (the restart-surviving on-disk backing, persisting
// `(namespace, threadId) → ThreadRecord` under the namespace's `storage`
// root). A host injects `FileThreadStore` at mount time (M5.5/A4). The
// per-driver `sessionId` + `AgentMetadata` on {@link AgentPersistentState}
// (M5.5) subsume what the ACP-coupled session store previously held.

import type { Namespace } from '@agenetes/protocol';
import { agentMetadataSchema, type AgentMetadata } from '@agenetes/protocol';

import { atomicWriteJson, readJson, sanitizeId } from './io.js';

/**
 * The durable, restart-surviving state Agenetes keeps for one thread —
 * the "persistent" half of a thread-table entry, held independently of
 * whether a live handle exists (I9.4).
 *
 * It pins the namespace `storage` root the thread persists under (I4.1),
 * the low-level driver `sessionId` (I4.3 — e.g. an ACP session id for
 * `session/load` recovery), and the last-known driver-agnostic
 * {@link AgentMetadata} snapshot (M5.5) folded from the agent's meta
 * updates. `sessionId` / `metadata` are absent until a driver reports
 * them; the metadata is replaced wholesale on each update via a
 * {@link ThreadStore} `upsert` (this class is immutable — no in-place
 * mutation).
 */
export class AgentPersistentState {
  /**
   * Absolute root this thread's L2 state persists under, derived from its
   * namespace's `storage.root` (I4.1). `undefined` when the namespace
   * supplied no storage (L2 falls back to its own default location).
   */
  readonly storageRoot: string | undefined;

  /**
   * The low-level driver session id (I4.3), e.g. the ACP session id the
   * driver reuses for `session/load` recovery. Absent until the driver
   * establishes one.
   */
  readonly sessionId: string | undefined;

  /**
   * Last-known driver-agnostic metadata snapshot (M5.5): the folded
   * selectable / usage surface. Absent until the agent reports any meta.
   */
  readonly metadata: AgentMetadata | undefined;

  constructor(
    storageRoot: string | undefined,
    sessionId?: string,
    metadata?: AgentMetadata,
  ) {
    this.storageRoot = storageRoot;
    this.sessionId = sessionId;
    this.metadata = metadata;
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
 * restart-surviving backing is {@link FileThreadStore}, injected by a host
 * at mount time (M5.5/A4). Namespaces are isolated: records never leak
 * across `name`.
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

/** Bumped only on a breaking layout change to the persisted file. */
const THREAD_STORE_SCHEMA_VERSION = 1;

/** The persisted shape of one thread record's durable `state`. */
interface PersistedState {
  storageRoot?: string;
  sessionId?: string;
  metadata?: AgentMetadata;
}

/** The on-disk `threads.json` file shape. */
interface ThreadStoreFile {
  schemaVersion: number;
  records: Record<string, { spec: unknown; state: PersistedState }>;
}

/** Minimal shape every {@link WorkloadSpecShape} carries (I9.6). */
function isPersistableSpec(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.threadId === 'string' &&
    typeof s.kind === 'string' &&
    typeof s.workloadType === 'string' &&
    typeof s.namespace === 'object' &&
    s.namespace !== null
  );
}

/**
 * The restart-surviving {@link ThreadStore} — the on-disk twin of
 * {@link InMemoryThreadStore}, persisting `(namespace, threadId) →
 * ThreadRecord` as `<namespace.storage.root>/threads.json` (one file per
 * namespace). A host injects it at mount time (M5.5/A4).
 *
 * It reads/writes ONLY the current `{ spec, state }` shape; it ships no
 * legacy reader. Pre-existing `acp-sessions.json` data (the ACP-coupled
 * predecessor) is left untouched until the M6.9 one-shot migrator converts
 * it — we do not touch legacy canvas data before M6.9 is ready.
 *
 * ### Trust + atomicity
 *
 * Reads tolerate a missing / malformed file (return empty / skip the bad
 * record) so a corrupt persistence layer never bricks the lifecycle. The
 * `metadata` field is re-validated through {@link agentMetadataSchema}'s
 * `safeParse` so a single malformed snapshot is dropped rather than
 * poisoning the record. Writes go through {@link atomicWriteJson} so
 * concurrent readers see either the old or the new full snapshot.
 *
 * ### Concurrency
 *
 * Cross-thread writes on the same namespace race on the file: each writer
 * read-modify-writes the whole file, so the last writer wins for the FILE,
 * but a writer never deletes other threads' entries during a write.
 * Acceptable for a per-namespace record table (mirrors the predecessor).
 */
export class FileThreadStore implements ThreadStore {
  #path(namespace: Namespace): string {
    const root =
      namespace.storage?.root ??
      // Dormant fallback for a namespace with no storage root: a
      // process-local default under the cwd. Hosts always supply an
      // explicit `storage.root`, so this is defence-in-depth only.
      `${process.cwd()}/.agenetes/namespaces/${sanitizeId(namespace.name, 'namespace')}`;
    return `${root}/threads.json`;
  }

  #readFile(namespace: Namespace): ThreadStoreFile {
    const raw = readJson<unknown>(this.#path(namespace));
    if (!raw || typeof raw !== 'object') {
      return { schemaVersion: THREAD_STORE_SCHEMA_VERSION, records: {} };
    }
    const obj = raw as Record<string, unknown>;
    const records: ThreadStoreFile['records'] = {};
    const maybe = obj.records;
    if (maybe && typeof maybe === 'object') {
      for (const [threadId, value] of Object.entries(
        maybe as Record<string, unknown>,
      )) {
        if (!value || typeof value !== 'object') continue;
        const entry = value as { spec?: unknown; state?: unknown };
        if (!isPersistableSpec(entry.spec)) continue;
        records[threadId] = {
          spec: entry.spec,
          state: sanitizeState(entry.state),
        };
      }
    }
    return { schemaVersion: THREAD_STORE_SCHEMA_VERSION, records };
  }

  #toRecord<TSpec>(entry: {
    spec: unknown;
    state: PersistedState;
  }): ThreadRecord<TSpec> {
    return {
      spec: entry.spec as TSpec,
      state: new AgentPersistentState(
        entry.state.storageRoot,
        entry.state.sessionId,
        entry.state.metadata,
      ),
    };
  }

  upsert<TSpec>(
    namespace: Namespace,
    threadId: string,
    record: ThreadRecord<TSpec>,
  ): void {
    sanitizeId(threadId, 'threadId');
    const file = this.#readFile(namespace);
    const state: PersistedState = {};
    if (record.state.storageRoot !== undefined) {
      state.storageRoot = record.state.storageRoot;
    }
    if (record.state.sessionId !== undefined) {
      state.sessionId = record.state.sessionId;
    }
    if (record.state.metadata !== undefined) {
      state.metadata = record.state.metadata;
    }
    file.records[threadId] = { spec: record.spec, state };
    atomicWriteJson(this.#path(namespace), file);
  }

  get<TSpec = unknown>(
    namespace: Namespace,
    threadId: string,
  ): ThreadRecord<TSpec> | undefined {
    const entry = this.#readFile(namespace).records[threadId];
    return entry ? this.#toRecord<TSpec>(entry) : undefined;
  }

  list<TSpec = unknown>(namespace: Namespace): ThreadRecord<TSpec>[] {
    return Object.values(this.#readFile(namespace).records).map((entry) =>
      this.#toRecord<TSpec>(entry),
    );
  }

  delete(namespace: Namespace, threadId: string): void {
    const file = this.#readFile(namespace);
    if (!(threadId in file.records)) return;
    delete file.records[threadId];
    atomicWriteJson(this.#path(namespace), file);
  }
}

/**
 * Defensively shape-check a persisted `state` blob. Passes `storageRoot` /
 * `sessionId` through when they are strings, and re-validates `metadata`
 * via {@link agentMetadataSchema} so a malformed snapshot is dropped rather
 * than trusted. Never throws — a corrupt state degrades to an empty one.
 */
function sanitizeState(raw: unknown): PersistedState {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: PersistedState = {};
  if (typeof r.storageRoot === 'string') out.storageRoot = r.storageRoot;
  if (typeof r.sessionId === 'string') out.sessionId = r.sessionId;
  if (r.metadata !== undefined) {
    const parsed = agentMetadataSchema.safeParse(r.metadata);
    if (parsed.success) out.metadata = parsed.data;
  }
  return out;
}
