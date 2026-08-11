// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Structured storage port — domain records, not opaque bytes.
 *
 * The connection ({@link StructuredStore}) owns backend identity and
 * lifecycle, and vends a {@link SpaceHandle} per Space. The handle is a
 * composite of narrow, asynchronous repositories: the versioned Space record
 * ({@link SpaceRepository}), four Canvas-owned log-family repositories, the
 * canonical Task/Run repository, and read-only node snapshots
 * ({@link NodeRepository}).
 *
 * Record, delta, and node repositories are deliberately read-only. Durable
 * aggregate mutation is reachable only through {@link SpaceHandle.commit},
 * so a caller cannot advance one part of a Space independently of its version
 * and publication row.
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
  CanvasCommitEvent,
  CanvasSummary,
  ExecuteOriginator,
  IntentEpisode,
  RecentAction,
  TaskRecord,
  TaskRunRecord,
  TaskStoreSnapshot,
} from '@huabu/shared';
import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

export type StructuredBackendKind = 'disk' | 'sqlite' | 'postgres';

/** A connection to a structured backend. Process-wide; handles are derived. */
export interface StructuredStore {
  readonly kind: StructuredBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  /**
   * Return a repository for the currently-bound Space catalogue.
   *
   * Catalogue handles are scoped to the backend namespace that was active
   * when they were created. A caller that changes Workspace must resolve a
   * fresh handle; retained Disk handles reject instead of reading the newly
   * active Workspace.
   */
  catalog(): SpaceCatalogRepository;
  /**
   * Return the backend-neutral owner of Space creation and deletion.
   *
   * Lifecycle repositories are bound to the backend namespace that was
   * active when they were created. Cross-store cleanup (currently Canvas
   * blobs) is supplied through the delete hook so the structured record stays
   * present until that independently durable cleanup succeeds.
   */
  lifecycle(): SpaceLifecycleRepository;
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

// ─── Space lifecycle ───────────────────────────────────────────────────────────────────

export interface SpaceCreateInput {
  readonly canvasId: string;
  readonly title: string | null;
}

export type SpaceCreateResult =
  | {
      readonly ok: true;
      readonly record: CanvasFile;
      /** Canonical title after filesystem-name de-duplication. */
      readonly effectiveTitle: string | null;
    }
  | { readonly ok: false; readonly reason: 'already-exists' };

export interface SpaceDeleteInput {
  readonly canvasId: string;
  /**
   * Cleanup owned by another store that must finish while the structured
   * record still names it. A rejection leaves the Space intact and retryable.
   * The hook is never invoked for World.
   */
  readonly beforeRemove?: () => Promise<void>;
}

export type SpaceDeleteResult =
  | { readonly ok: true; readonly reason: 'deleted' }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'world-forbidden';
    };

/** Aggregate membership lifecycle for one structured backend namespace. */
export interface SpaceLifecycleRepository {
  /** Create one empty version-0 Space; exactly one same-id caller wins. */
  create(input: SpaceCreateInput): Promise<SpaceCreateResult>;
  /**
   * Delete one Space. Environmental failures reject; business outcomes are
   * returned explicitly.
   */
  delete(input: SpaceDeleteInput): Promise<SpaceDeleteResult>;
}

/** Read-only membership and World identity for one backend namespace. */
export interface SpaceCatalogRepository {
  /**
   * List ordinary, user-visible Spaces. World is never included.
   *
   * Ordering is deliberately unspecified. Environmental and integrity
   * failures reject rather than returning a partial catalogue.
   */
  list(): Promise<CanvasSummary[]>;
  /**
   * Return the stable id of the hidden World Space.
   *
   * A missing or malformed World is an integrity failure and rejects.
   */
  worldId(): Promise<string>;
}

/** Structured records for one Space. */
export interface SpaceHandle {
  readonly canvasId: string;
  readonly record: SpaceRepository;
  readonly events: CanvasEventRepository;
  readonly deltas: CanvasDeltaRepository;
  readonly changes: CanvasChangeRepository;
  readonly intents: CanvasIntentRepository;
  readonly tasks: CanvasTaskRepository;
  /** Portable, asynchronous node reads. */
  readonly nodes: NodeRepository;
  /**
   * Atomically replace the Space record, mutate node records, advance the
   * global version, and append the durable publication row.
   *
   * This is the only portable structured mutation authority. Repositories on
   * the handle remain independently readable, but application writers must
   * express their changes as one aggregate commit.
   */
  commit(input: SpaceCommitInput): Promise<SpaceCommitResult>;
}

// ─── Aggregate Space commit ───────────────────────────────────────────────

/** Record fields authored by a Space commit; identity/version are derived. */
export interface SpaceCommitRecord {
  readonly title: string | null;
  readonly state: CanvasFile['state'];
}

/** Durable publication metadata stored with the version transition. */
export interface SpaceCommitPublication {
  readonly originator: ExecuteOriginator;
  /** Whether the initiating client already applied the mutation locally. */
  readonly optimistic: boolean;
  readonly commands: readonly unknown[];
  readonly structureDeltas: readonly unknown[];
  readonly runId?: string;
}

export interface SpaceCommitInput {
  /** Current global Space version observed by the caller. */
  readonly expectedVersion: number;
  /** Canonical post-commit title and state. */
  readonly record: SpaceCommitRecord;
  /** Whole-record OCC baselines for every node mutation. */
  readonly nodePreconditions: readonly NodePrecondition[];
  readonly nodeMutations: readonly SpaceNodeMutation[];
  readonly publication: SpaceCommitPublication;
  /**
   * Temporary Canvas-PUT compatibility: advance even when the canonical
   * aggregate is unchanged. Remove with the tracked no-op autosave follow-up.
   */
  readonly forceVersionBump?: boolean;
}

export type SpaceCommitConflict =
  | { readonly reason: 'not-found' }
  | {
      readonly reason: 'version-conflict';
      readonly actualVersion: number;
      readonly structureRevision: string;
    }
  | {
      readonly reason: 'node-conflict';
      readonly nodeId: string;
      readonly actualRevision: NodeRecordRevision | null;
    }
  | {
      /** A put must agree with the canonical post-commit topology. */
      readonly reason: 'node-topology-conflict';
      readonly nodeId: string;
      readonly mutationType: string;
      readonly topologyType: string | null;
    }
  | {
      readonly reason: 'node-name-conflict';
      readonly nodeId: string;
      readonly conflictWith: {
        readonly id: string;
        readonly logicalName: string;
      };
    }
  | {
      readonly reason: 'duplicate-node';
      readonly nodeId: string;
      readonly logicalNames: readonly string[];
    }
  | { readonly reason: 'node-write-suppressed'; readonly nodeId: string }
  | { readonly reason: 'world-title-forbidden' }
  | { readonly reason: 'title-conflict'; readonly conflictWith: string };

export type SpaceCommitResult =
  | {
      readonly ok: true;
      readonly committed: boolean;
      readonly record: CanvasFile;
      /** Canonical response/broadcast envelope minted by the server. */
      readonly event: CanvasCommitEvent;
      /** Post-commit snapshots for successful puts; deletes are omitted. */
      readonly nodes: readonly NodeSnapshot[];
    }
  | ({ readonly ok: false } & SpaceCommitConflict);

// ─── Space record ───────────────────────────────────────────────────────────

/**
 * The versioned structural record for one Space (`space.json` on Disk).
 *
 * Mutation belongs to {@link SpaceHandle.commit}; lifecycle membership belongs
 * to {@link SpaceLifecycleRepository}.
 */
export interface SpaceRepository {
  /** The current record, or null when the Space does not exist. */
  read(): Promise<CanvasFile | null>;
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
 * Durable commit publications for one Space. Writes are emitted only by
 * {@link SpaceHandle.commit}; reads preserve version order.
 */
export interface CanvasDeltaRepository {
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

// ─── Node records ──────────────────────────────────────────────────────────

declare const nodeRecordRevisionBrand: unique symbol;

/**
 * Opaque revision of one complete canonical node record.
 *
 * Callers may retain and compare the token, but must not parse or synthesize
 * it. The revision changes when any persisted record field or its logical name
 * changes; it is deliberately broader than content-only HTTP ETags.
 */
export type NodeRecordRevision = string & {
  readonly [nodeRecordRevisionBrand]: true;
};

/** One canonical node record together with its backend-neutral identity. */
export interface NodeSnapshot {
  readonly record: NodeContent;
  readonly revision: NodeRecordRevision;
  /**
   * Single-segment logical sidecar name (for example `Meeting notes.md`).
   * It is never an absolute path or a backend storage locator.
   */
  readonly logicalName: string;
  /** All colliding logical names when more than one record claims this id. */
  readonly duplicateLogicalNames?: readonly string[];
}

/** Expected node state used by an aggregate Space commit. */
export interface NodePrecondition {
  readonly nodeId: string;
  /** `null` means the node must be absent. */
  readonly revision: NodeRecordRevision | null;
}

/** Node portion of an aggregate Space commit. */
export type SpaceNodeMutation =
  | {
      readonly kind: 'put';
      readonly record: NodeContent;
      /** User-authored label renames reject instead of auto-deduping. */
      readonly strictRename?: boolean;
    }
  | { readonly kind: 'delete'; readonly nodeId: string };

/**
 * Portable, read-only access to canonical node records.
 *
 * Mutation intentionally belongs to the aggregate Space commit rather than
 * this repository, so structural state and node sidecars cannot acquire
 * independent write authorities.
 */
export interface NodeRepository {
  read(nodeId: string): Promise<NodeSnapshot | null>;
  /** Return found records keyed by id; missing ids are omitted. */
  readMany(
    nodeIds: readonly string[],
  ): Promise<ReadonlyMap<string, NodeSnapshot>>;
}
