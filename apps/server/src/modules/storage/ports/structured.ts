// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Structured storage port — domain records, not opaque bytes.
 *
 * The connection ({@link StructuredStore}) owns backend identity and
 * lifecycle. It vends two things: a {@link SpaceRepository} for the Space
 * collection in one backend namespace, and a {@link SpaceHandle} per Space.
 *
 * A `SpaceHandle` *is* the Space record — `read()` and `write()` sit directly
 * on the handle — and its members name the durable **parts the Space holds**:
 * its nodes, its pending review, its Tasks, and its history. Each part carries
 * its own operations, and no member's noun is really a verb: `write()` spans
 * the record and the nodes, so it belongs to the Space rather than to either
 * part.
 *
 * Verbs mean one thing throughout: `read` fetches one record or a part's
 * contents; `list` fetches a whole collection; `create` adds where an existing
 * record is an error; `put` writes one complete record by id, replacing it if
 * present; `append` adds to an ordered sequence; `update` changes part of an
 * existing record; `delete` removes one record by id; `write` is the Space's
 * own ordered multi-part mutation. `create` and `put` stay distinct because
 * they behave differently on a duplicate. `worldId()` and `beginDelete()` are
 * the deliberate exceptions: one names what it returns, the other opens a
 * session.
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
  RecentAction,
  TaskRecord,
  TaskRunCompletion,
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
 * ... suffixes. Choosing a title for an *unnamed* Space is a product naming
 * rule rather than a storage one, so this port never invents one: `title:
 * null` stays null, and the "Untitled", "Untitled (1)", ... default is
 * allocated by `createSpace` in the composition layer, above every adapter.
 * Deletion concerns
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
  /**
   * Return the stable World, creating it once if this namespace is new.
   *
   * The backend-neutral bootstrap hook. Every backend meets an empty
   * namespace the first time it is mounted, and a Workspace without a World
   * has no Portal target and no home view — so ensuring one cannot stay a
   * Disk-shaped step run before the store exists.
   *
   * Idempotent, and deliberately narrower than "create if absent": it mints a
   * version-0 World only when the namespace holds no World at all. An
   * *established* World that is missing or malformed stays the integrity
   * error {@link worldId} reports, because regenerating identity there would
   * silently orphan every Portal that referenced it.
   */
  ensureWorld(): Promise<string>;
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

/**
 * One Space: its own record, the parts it holds, and the write that spans them.
 *
 * `read` and `write` are the Space's own pair — it *is* the versioned
 * structural record (version, title, topology), so wrapping that record in a
 * member would put reading it and writing it at two different levels. Every
 * other member is a durable part with its own operations.
 *
 * Reading is scoped deliberately: create, delete, World rules, and title
 * mutation are collection concerns on {@link SpaceRepository}, and every record
 * *write* goes through {@link SpaceHandle.write} — the same version-checked
 * replacement with the node batch attached, so a second write entry point would
 * only be a narrower spelling of one operation.
 */
export interface SpaceHandle {
  readonly canvasId: string;
  /** The current Space record, or null when the Space does not exist. */
  read(): Promise<CanvasFile | null>;
  /**
   * Replace the record and mutate nodes as one ordered write.
   *
   * Existing executor persistence semantics; not a transaction. A method
   * rather than a member, because it is an action over two parts and belongs
   * to neither of them.
   */
  write(input: SpaceWriteInput): Promise<SpaceWriteResult>;
  /** Complete node records, addressed by stable id. */
  readonly nodes: SpaceNodes;
  /** Agent-proposed changes awaiting review, per thread. */
  readonly changes: SpaceChanges;
  /** Tasks and the Runs that execute them. */
  readonly tasks: SpaceTasks;
  /**
   * What already happened in this Space, as behavioural events.
   *
   * Flat, not under a `history` group. That group existed to hold events
   * beside intent episodes — two kinds of past record, one noun over them.
   * With intents gone it would be a single-member wrapper, and a member whose
   * only job is to hold one other member is a level the reader pays for and
   * learns nothing from. A second kind of past record can reintroduce it.
   */
  readonly events: SpaceEvents;
}

// ─── The ordered Space write ─────────────────────────────────────────────────

export type SpaceWriteResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'version-conflict'; actualVersion: number };

export type SpaceNodeMutation =
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

/**
 * One ordered Space write: node puts/deletes, then the Space record, then an
 * optional journal row.
 *
 * The record replacement is version-checked against `expectedVersion` and
 * `nextRecord.version` must be exactly `expectedVersion + 1`. The check and
 * the replacement are **one** operation: two concurrent writes from the same
 * observed version cannot both succeed. `nextRecord` must address this Space,
 * and its identity fields (`canvasId`, `title`, `createdAt`) must match the
 * current record — title addressing is an explicit collection operation
 * outside this batch.
 *
 * Business outcomes are returned as {@link SpaceWriteResult}; malformed input
 * and operational failures reject, and never masquerade as `not-found` or as a
 * business result. A rejected batch must not leave a visible completed prefix
 * under continued adapter operation. This is a call-level failure guarantee,
 * not crash durability: callers receive no portable guarantee for process
 * termination, power loss, loss of the backend connection while the outcome is
 * unknown, uncoordinated multi-process access, idempotent retry, or
 * publication. A successful write only means the requested storage operations
 * completed; it does not mint or broadcast a wire-protocol event.
 */
export interface SpaceWriteInput {
  /** Space version observed before preparing this write. */
  readonly expectedVersion: number;
  /** Complete record to install after all node mutations succeed. */
  readonly nextRecord: CanvasFile;
  readonly nodeMutations: readonly SpaceNodeMutation[];
  /**
   * Executor delta to journal after the record write.
   *
   * How — or whether — a backend retains this row is its own business. No port
   * member reads the journal back: it is written as part of the executor's
   * write, not exposed as a part of a Space, because nothing a reader of a
   * Space needs to understand is expressed by it.
   */
  readonly delta?: DeltaLogEntry;
  /**
   * Preserve the legacy implicit-create path for a write to an absent Space.
   * Omitted or false means an absent Space returns `not-found`.
   */
  readonly allowCreate?: boolean;
}

// ─── History ────────────────────────────────────────────────────────────────

/** Input shape for an event append; `ts` defaults to server time. */
export interface NewCanvasEvent {
  payload: RecentAction;
  ts?: number;
}

/** Behavioural events for one Space. One append batch lands contiguously. */
export interface SpaceEvents {
  /** Chronological; when `limit` is set, only the most recent `limit`. */
  read(limit?: number): Promise<CanvasEvent[]>;
  append(events: readonly NewCanvasEvent[]): Promise<void>;
}

// ─── Pending review ─────────────────────────────────────────────────────────

/**
 * Per-thread change-review records for one Space.
 *
 * Appends and deletes are linearizable per Space/thread pair. Reads and the
 * value returned by `append` are coalesced by canvas entity.
 */
export interface SpaceChanges {
  read(threadId: string): Promise<CanvasChangeRecord[]>;
  append(
    threadId: string,
    records: readonly CanvasChangeRecord[],
  ): Promise<CanvasChangeRecord[]>;
  /** The deleted record, or null when the thread holds no such change. */
  delete(
    threadId: string,
    changeId: string,
  ): Promise<CanvasChangeRecord | null>;
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

export type TaskRunUpdate = Partial<
  Pick<TaskRunRecord, 'rootNodeId' | 'rootThreadId' | 'startedAt'>
> & {
  status?: Exclude<TaskRunRecord['status'], 'completed'>;
};

export type TaskRunCompletionResult =
  | { outcome: 'completed' | 'unchanged'; run: TaskRunRecord }
  | { outcome: 'task_not_found' | 'run_not_found' }
  | {
      outcome: 'run_not_running' | 'completion_conflict';
      run: TaskRunRecord;
    };

/**
 * The canonical Task ledger for one Space.
 *
 * `read` returns Tasks and Runs together: a Run is only meaningful beside the
 * Task it executes, and the referential invariant between them has one owner
 * here. That is also why {@link SpaceTaskRuns} has no read of its own — a
 * second read path would be a second representation of records this snapshot
 * already carries, and could hand a caller a Run whose Task it never observed.
 */
export interface SpaceTasks {
  read(): Promise<TaskStoreSnapshot>;
  /** Rejects a Task id that already exists. */
  create(task: TaskRecord): Promise<void>;
  readonly runs: SpaceTaskRuns;
}

/** Runs of this Space's Tasks. Reads come from {@link SpaceTasks.read}. */
export interface SpaceTaskRuns {
  /** Rejects a duplicate Run id, or a Run referencing an absent Task. */
  create(run: TaskRunRecord): Promise<void>;
  update(runId: string, update: TaskRunUpdate): Promise<TaskRunRecord>;
  /**
   * Atomically completes one running Run. Repeating the same completion
   * message is idempotent; a different message conflicts.
   */
  complete(
    taskId: string,
    runId: string,
    completion: TaskRunCompletion,
  ): Promise<TaskRunCompletionResult>;
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
 * or physical layout.
 *
 * Every read is **strict about retrievability and lenient about content**. A
 * record that exists but cannot be produced is an environmental failure and
 * rejects — never absence, and never a silently shorter collection. A record
 * whose stored content is malformed is recovered rather than refused, because
 * on a backend that keeps records in files a user can damage one by hand, and
 * a record no read will produce cannot be repaired through the routes that
 * exist to repair it. The two rules hold identically on {@link SpaceNodes.read},
 * {@link SpaceNodes.readMany}, {@link SpaceNodes.list}, and
 * {@link SpaceNodes.stream}.
 *
 * Two mutation outcomes are **adapter-shaped** and optional:
 *
 * - `duplicate-node`, for adapters that can observe conflicting physical
 *   representations of one stable id. Such an adapter may return one readable
 *   representative from `read` so a caller can construct the attempted
 *   update, but it must refuse the `put` rather than overwrite an arbitrary
 *   representation.
 * - `write-suppressed`, for adapters that keep a deleted id fenced against
 *   late in-flight writes. See {@link SpaceNodeMutation}'s
 *   `authoritativeInsert`, which is how a batch re-insertion is distinguished
 *   from such a late write.
 *
 * A SQL adapter with a unique key produces neither.
 */
export interface SpaceNodes {
  /**
   * The Space these nodes belong to.
   *
   * Retained although {@link SpaceHandle} carries the same id: preprocessing
   * resolves this part per request and works with it detached from its handle.
   */
  readonly canvasId: string;
  read(nodeId: string): Promise<NodeSnapshot | null>;
  /**
   * The named nodes that exist, keyed by stable id.
   *
   * An absent id is a missing key, not an error: a caller asking for a
   * selection is describing what it wants, not asserting that all of it is
   * there. Reading the same id through {@link read} yields the same record and
   * the same revision.
   *
   * This is the shape most readers want — a selection to describe, a
   * neighbourhood to render, one View to serve — and it exists so their cost
   * stays proportional to the request. Expressed as {@link list} the same read
   * makes an unrelated node somewhere else part of the bill, and no backend
   * serves that better than it serves a lookup by id.
   */
  readMany(nodeIds: readonly string[]): Promise<Map<string, NodeSnapshot>>;
  /**
   * Every node in this Space, keyed by stable id.
   *
   * For work that genuinely spans the Space — executor prestate hydration,
   * the Space GET, the canvas outline, cross-node inspection. Iteration order
   * is unspecified; a caller that needs an order imposes it.
   *
   * Answers about exactly the nodes {@link read} would, under the same two
   * rules the interface states: a record that cannot be retrieved rejects the
   * scan, and a record whose content is malformed is recovered. Dropping the
   * unretrievable member instead — serving the rest of the collection — was
   * considered and rejected: it would leave this port promising that
   * environmental failures reject while its two collection shapes reported
   * absence, and no caller could then tell a Space that lost a node from one
   * it merely cannot read right now.
   */
  list(): Promise<Map<string, NodeSnapshot>>;
  /**
   * {@link list}, delivering each record as it lands.
   *
   * `onNode` is invoked once per node, never concurrently with itself, before
   * the returned map settles; the map is the same collection {@link list}
   * would return. Delivery order is arrival order, and is deliberately not a
   * query order — a backend may serve in whatever order is cheapest, and none
   * of them promises a resumable cursor. This is a latency shape for a reader
   * that can show partial results, not a pagination contract.
   */
  stream(
    onNode: (snapshot: NodeSnapshot) => void,
    options?: NodeStreamOptions,
  ): Promise<Map<string, NodeSnapshot>>;
  put(input: NodePutInput): Promise<NodePutResult>;
  delete(nodeId: string): Promise<NodeDeleteResult>;
}

export interface NodeStreamOptions {
  /**
   * Polled as the scan proceeds; an aborted scan stops delivering early.
   *
   * The returned promise still settles, so an adapter never leaks a pending
   * scan, but its map is then partial by definition. A caller that aborts
   * must check its own signal rather than reading the result.
   */
  readonly signal?: { readonly aborted: boolean };
}
