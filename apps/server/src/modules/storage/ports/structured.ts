// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Structured storage port — domain records, not opaque bytes.
 *
 * The connection ({@link StructuredStore}) owns backend identity and
 * lifecycle. It vends two things: a {@link SpaceRepository} for the Space
 * collection in one backend namespace, and a {@link SpaceHandle} per Space.
 * The handle is a composite of narrow, asynchronous repositories: the
 * versioned Space record, node records, four Canvas-owned log-family
 * repositories, the canonical Task/Run repository, and the existing ordered
 * executor write sequence.
 *
 * Guarantee scope: the concurrency properties below (single-winner record
 * writes, linearizable appends) are **adapter-local**. They hold for calls
 * made through these repositories. The compatibility facade remains a second
 * mutation entry point until its writers migrate, so a passing contract suite
 * is not evidence that the running application has one write authority. See
 * §12.2.3.
 *
 * This file may not import a backend implementation or the compatibility
 * layer. Persistence DTOs come from the Canvas domain.
 */

import type { StorageHealth } from './common.js';
import type {
  CanvasEvent,
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../canvas/persistence-types.js';
import type {
  CanvasSummary,
  IntentEpisode,
  RecentAction,
  TaskRecord,
  TaskRunRecord,
  TaskStoreSnapshot,
} from '@huabu/shared';
import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

/**
 * Backends with a structured adapter today.
 *
 * This is what an adapter may report as its own `kind`, so it names only what
 * exists. The wider vocabulary a profile may *request* — including families
 * that are configurable but unimplemented — belongs to `profile.ts`, which
 * owns rejecting them with an actionable message.
 */
export type StructuredBackendKind = 'disk';

/** A connection to a structured backend. Process-wide; handles are derived. */
export interface StructuredStore {
  readonly kind: StructuredBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  /**
   * Return a repository for the currently-bound Space collection.
   *
   * Handles are scoped to the backend namespace that was active when they
   * were created. A caller that changes Workspace must resolve a fresh
   * handle; retained Disk handles reject instead of reading the newly active
   * Workspace.
   */
  spaces(): SpaceRepository;
  /**
   * Return the handle for one validated Space id.
   *
   * Handles for the same id denote the same Space; handles for different ids
   * are isolated. Object identity is deliberately *not* promised: the Disk
   * adapter serves the underlying state from a bounded cache, so a process
   * working with more Spaces than that cache holds can be handed a fresh
   * instance for an id it served before. Anything that must outlive that is
   * durable state and belongs in a repository, not on a handle.
   */
  space(canvasId: string): SpaceHandle;
}

// ─── The Space collection ───────────────────────────────────────────────────

export interface SpaceCreateInput {
  readonly canvasId: string;
  readonly title: string | null;
}

export type SpaceCreateResult =
  | { readonly ok: true; readonly record: CanvasFile }
  | { readonly ok: false; readonly reason: 'already-exists' };

export interface SpaceDeleteInput {
  readonly canvasId: string;
}

export type SpaceDeleteFinishResult =
  | { readonly ok: true; readonly reason: 'deleted' }
  | { readonly ok: false; readonly reason: 'not-found' };

/**
 * Exclusive structured-deletion session for one Space.
 *
 * While open, every mutation for the same Space must reject, including
 * create/rename, node writes, ordered batches, logs, and Tasks. Reads remain
 * available so composition can identify and clean external blobs. `finish`
 * removes structured state and closes the session; `abort` leaves it intact
 * and is idempotent. A caller must invoke one terminal method.
 */
export interface SpaceDeleteSession {
  finish(): Promise<SpaceDeleteFinishResult>;
  abort(): Promise<void>;
}

export type SpaceBeginDeleteResult =
  | { readonly ok: true; readonly session: SpaceDeleteSession }
  | { readonly ok: false; readonly reason: 'world-forbidden' };

export interface SpaceRenameInput {
  readonly canvasId: string;
  readonly title: string | null;
}

export type SpaceRenameResult =
  | { readonly ok: true; readonly record: CanvasFile }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'world-forbidden';
    }
  | {
      readonly ok: false;
      readonly reason: 'title-conflict';
      /** Existing logical title that owns the conflicting backend slot. */
      readonly conflictingTitle: string | null;
    };

/**
 * Membership, World identity, and lifecycle for the Spaces in one backend
 * namespace.
 *
 * Reads and lifecycle mutations share one repository because they share one
 * subject and one invariant: what the collection contains, and which member
 * is the protected World. Splitting them put the World rule in two places and
 * left creation reading membership it could not name.
 *
 * `list` returns ordinary, user-visible Spaces; World is never included, and
 * ordering is deliberately unspecified. Environmental and integrity failures
 * reject rather than returning a partial collection.
 *
 * Creation returns the authoritative version-0 record. For a repeated
 * non-null requested title, allocation preserves the existing product rule:
 * the first record keeps the title and later records receive ` (2)`, ` (3)`,
 * ... suffixes. A default title for an unnamed Space is a product naming rule
 * rather than a storage one, so it stays with the caller. Deletion concerns
 * structured state only: blob cleanup and cross-store ordering remain
 * composition-layer responsibilities. Rename is deliberately separate from
 * the ordered record/node writer: its existing addressing side effect may
 * complete before a later, independent record write fails.
 */
export interface SpaceRepository {
  list(): Promise<CanvasSummary[]>;
  /**
   * Return the stable id of the hidden World Space.
   *
   * A missing or malformed World is an integrity failure and rejects.
   */
  worldId(): Promise<string>;
  create(input: SpaceCreateInput): Promise<SpaceCreateResult>;
  /**
   * Fence mutations before cross-store cleanup begins.
   *
   * An absent ordinary Space still returns a session so orphan blobs can be
   * swept; `session.finish()` then reports `not-found`. The guarantee covers
   * overlapping calls through this backend instance, not uncoordinated
   * processes or a crash while the session is open.
   */
  beginDelete(input: SpaceDeleteInput): Promise<SpaceBeginDeleteResult>;
  rename(input: SpaceRenameInput): Promise<SpaceRenameResult>;
}

/** Structured records for one Space. */
export interface SpaceHandle {
  readonly canvasId: string;
  readonly record: SpaceRecordRepository;
  readonly events: CanvasEventRepository;
  readonly deltas: CanvasDeltaRepository;
  readonly changes: CanvasChangeRepository;
  readonly intents: CanvasIntentRepository;
  readonly tasks: CanvasTaskRepository;
  readonly nodes: NodeRepository;
  /** Existing ordered executor persistence semantics; not a transaction. */
  readonly writer: OrderedSpaceWriter;
}

// ─── Space record ───────────────────────────────────────────────────────────

/**
 * Read access to the versioned structural record for one Space
 * (`space.json` on Disk).
 *
 * Scoped deliberately: create, delete, World rules, and title mutation are
 * collection concerns, and every record *write* goes through
 * {@link OrderedSpaceWriter} — which is the same version-checked replacement
 * with the node and delta batch attached, so a second write entry point here
 * would only be a narrower spelling of one operation.
 */
export interface SpaceRecordRepository {
  /** The current record, or null when the Space does not exist. */
  read(): Promise<CanvasFile | null>;
}

// ─── Ordered Space writes ───────────────────────────────────────────────────

export type SpaceMutationResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'version-conflict'; actualVersion: number };

export type OrderedNodeMutation =
  | {
      readonly kind: 'put';
      readonly nodeId: string;
      readonly record: NodeContent;
      /** Refuse a colliding logical label instead of de-duplicating it. */
      readonly strictLabel?: boolean;
      /**
       * Marks an executor-authoritative INSERT.
       *
       * **Adapter-shaped**, like {@link NodePutResult}'s `write-suppressed`.
       * It exists for a backend that suppresses writes to a recently deleted
       * id, and lets such an adapter distinguish a real re-insertion from a
       * late direct write that should stay suppressed. It is intentionally
       * batch-only. An adapter whose deletes are immediately final — a SQL
       * table with a unique key — can ignore it.
       */
      readonly authoritativeInsert?: boolean;
    }
  | { readonly kind: 'delete'; readonly nodeId: string };

export interface OrderedSpaceWriteInput {
  /** Space version observed before preparing this write. */
  readonly expectedVersion: number;
  /** Complete record to install after all node mutations succeed. */
  readonly nextRecord: CanvasFile;
  readonly nodeMutations: readonly OrderedNodeMutation[];
  /** Optional executor delta appended after the record write. */
  readonly delta?: DeltaLogEntry;
  /**
   * Preserve the legacy implicit-create path for a write to an absent Space.
   * Omitted or false means an absent Space returns `not-found`.
   */
  readonly allowCreate?: boolean;
}

/**
 * Apply one Space mutation in the observable order used by current writers:
 * node puts/deletes, Space-record replacement, then an optional delta append.
 *
 * The record replacement is version-checked against `expectedVersion` and
 * `nextRecord.version` must be exactly `expectedVersion + 1`. The check and
 * the replacement are **one** operation: two concurrent writes from the same
 * observed version cannot both succeed. `nextRecord` must address this Space,
 * and its identity fields (`canvasId`, `title`, `createdAt`) must match the
 * current record — title addressing is an explicit collection operation
 * outside this batch.
 *
 * Business outcomes are returned as {@link SpaceMutationResult}; malformed
 * input and operational failures reject, and never masquerade as `not-found`
 * or as a business result. A rejected node/record/delta batch must not leave
 * a visible completed prefix under continued adapter operation. This is a
 * call-level failure guarantee, not crash durability: callers receive no
 * portable guarantee for process termination, power loss, loss of the backend
 * connection while the outcome is unknown, uncoordinated multi-process
 * access, idempotent retry, or publication. A successful write only means the
 * requested storage operations completed; it does not mint or broadcast a
 * wire-protocol event.
 */
export interface OrderedSpaceWriter {
  apply(input: OrderedSpaceWriteInput): Promise<SpaceMutationResult>;
}

// ─── Canvas logs ────────────────────────────────────────────────────────────

/** Input shape for an event append; `ts` defaults to server time. */
export interface NewCanvasEvent {
  payload: RecentAction;
  ts?: number;
}

/** Behavioural events for one Space. One append batch lands contiguously. */
export interface CanvasEventRepository {
  append(events: readonly NewCanvasEvent[]): Promise<void>;
  /** Chronological; when `limit` is set, only the most recent `limit`. */
  read(limit?: number): Promise<CanvasEvent[]>;
}

/**
 * Executor deltas for one Space.
 *
 * Versions are unique and strictly increasing; duplicate or older appends
 * reject, and reads preserve version order.
 */
export interface CanvasDeltaRepository {
  append(entry: DeltaLogEntry): Promise<void>;
  /** Rows with `version` strictly greater than `fromVersion`, in order. */
  readSince(fromVersion: number): Promise<DeltaLogEntry[]>;
}

/**
 * Per-thread change-review records for one Space.
 *
 * Appends and removals are linearizable per Space/thread pair. Reads and the
 * value returned by `append` are coalesced by canvas entity.
 */
export interface CanvasChangeRepository {
  read(threadId: string): Promise<CanvasChangeRecord[]>;
  append(
    threadId: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]>;
  remove(
    threadId: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null>;
}

/** Intent episodes for one Space. Upserts are linearizable by episode id. */
export interface CanvasIntentRepository {
  read(): Promise<IntentEpisode[]>;
  upsert(episode: IntentEpisode): Promise<void>;
}

export type TaskRunUpdate = Partial<
  Pick<TaskRunRecord, 'rootNodeId' | 'rootThreadId' | 'status' | 'startedAt'>
>;

/** Canonical Task and Run records for one Space. */
export interface CanvasTaskRepository {
  read(): Promise<TaskStoreSnapshot>;
  insertTask(task: TaskRecord): Promise<void>;
  insertRun(run: TaskRunRecord): Promise<void>;
  updateRun(runId: string, update: TaskRunUpdate): Promise<TaskRunRecord>;
}

// ─── Node records ───────────────────────────────────────────────────────────

/**
 * One complete node record and its opaque optimistic-concurrency token.
 */
export interface NodeSnapshot {
  readonly record: NodeContent;
  readonly revision: string;
}

export interface NodePutInput {
  readonly nodeId: string;
  readonly record: NodeContent;
  /**
   * When present, the write succeeds only from this observed storage token;
   * `null` explicitly requires the node to be absent.
   */
  readonly expectedRevision?: string | null;
  /** Reject a conflicting logical label instead of assigning another one. */
  readonly strictLabel?: boolean;
}

export type NodePutResult =
  | ({ readonly ok: true } & NodeSnapshot)
  | { readonly ok: false; readonly reason: 'not-found' }
  | {
      readonly ok: false;
      readonly reason: 'revision-conflict';
      readonly currentRevision: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: 'label-conflict';
      readonly conflictingNodeId: string;
      readonly conflictingLabel: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'duplicate-node';
      /** Adapter-local logical names involved in this integrity conflict. */
      readonly names: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'write-suppressed' };

export type NodeDeleteResult = 'deleted' | 'absent';

/**
 * Complete node-record persistence for one Space.
 *
 * Revisions are opaque full-record storage tokens, distinct from any public
 * content revision. Label allocation is a domain behavior: a non-strict put
 * may return a de-duplicated persisted label, while a strict put reports a
 * `label-conflict`. The contract intentionally says nothing about filenames
 * or physical layout. Environmental and malformed-record failures reject.
 *
 * Two mutation outcomes are **adapter-shaped** and optional:
 *
 * - `duplicate-node`, for adapters that can observe conflicting physical
 *   representations of one stable id. Such an adapter may return one readable
 *   representative from `read` so a caller can construct the attempted
 *   update, but it must refuse the `put` rather than overwrite an arbitrary
 *   representation.
 * - `write-suppressed`, for adapters that keep a deleted id fenced against
 *   late in-flight writes. See {@link OrderedNodeMutation}'s
 *   `authoritativeInsert`, which is how a batch re-insertion is distinguished
 *   from such a late write.
 *
 * A SQL adapter with a unique key produces neither.
 */
export interface NodeRepository {
  readonly canvasId: string;
  read(nodeId: string): Promise<NodeSnapshot | null>;
  put(input: NodePutInput): Promise<NodePutResult>;
  delete(nodeId: string): Promise<NodeDeleteResult>;
}
