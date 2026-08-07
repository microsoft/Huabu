/**
 * Structured storage port — domain records, not opaque bytes.
 *
 * The connection ({@link StructuredStore}) owns backend identity and
 * lifecycle, and vends a {@link SpaceHandle} per Space. The handle is a
 * composite of narrow, asynchronous repositories: the versioned Space record
 * ({@link SpaceRepository}) and four Canvas-owned log-family repositories.
 *
 * Scope note: node sidecars are still reached through
 * {@link LegacyNodeStore}, a deliberately narrow *synchronous* transitional
 * surface. Node persistence is the one part of the Space a non-Disk adapter
 * cannot yet implement, because the write coordinator's atomicity argument
 * depends on `readNode` / `writeNode` being synchronous. Replacing it is a
 * later phase; see docs/proposals/multi-backend-storage.md §12.2.7.
 *
 * Guarantee scope: the concurrency properties below (single-winner CAS,
 * linearizable appends) are **adapter-local**. They hold for calls made
 * through these repositories. The compatibility facade remains a second
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
import type { IntentEpisode, RecentAction } from '@sediment/shared';
import type { CanvasChangeRecord } from '@sediment/shared/canvas-engine';

export type StructuredBackendKind = 'disk' | 'sqlite' | 'postgres';

/** A connection to a structured backend. Process-wide; handles are derived. */
export interface StructuredStore {
  readonly kind: StructuredBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
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

/** Structured records for one Space. */
export interface SpaceHandle {
  readonly canvasId: string;
  readonly record: SpaceRepository;
  readonly events: CanvasEventRepository;
  readonly deltas: CanvasDeltaRepository;
  readonly changes: CanvasChangeRepository;
  readonly intents: CanvasIntentRepository;
  /** Synchronous transitional surface; replaced in a later phase. */
  readonly nodes: LegacyNodeStore;
}

// ─── Space record ───────────────────────────────────────────────────────────

export type SpaceWriteResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'version-conflict'; actualVersion: number };

/**
 * The versioned structural record for one Space (`space.json` on Disk).
 *
 * Scoped deliberately: create, delete, World rules, and title/directory
 * rename are aggregate lifecycle concerns that stay on the compatibility path
 * until their portable contract is designed. This repository only replaces
 * the record of a Space that already exists.
 */
export interface SpaceRepository {
  /** The current record, or null when the Space does not exist. */
  read(): Promise<CanvasFile | null>;
  /**
   * Replace the record iff its version is still `expectedVersion`.
   *
   * `next.version` must be exactly `expectedVersion + 1`, `next.canvasId`
   * must match this handle, and the identity fields (`canvasId`, `title`,
   * `createdAt`) must match the current record — this is not the rename or
   * lifecycle path.
   *
   * The version check and the replacement are **one** operation: two
   * concurrent calls with the same expected version cannot both succeed.
   *
   * Environmental IO failures reject; they never masquerade as `not-found`
   * or as a business result.
   */
  compareAndSwap(
    expectedVersion: number,
    next: CanvasFile,
  ): Promise<SpaceWriteResult>;
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

// ─── Node sidecars (transitional) ───────────────────────────────────────────

/**
 * Outcome of a node sidecar write.
 *
 * Declared here rather than imported from the Disk legacy class so this port
 * stays free of backend imports; the Disk wrapper's return value is
 * structurally this type.
 */
export type NodeWriteResult =
  | {
      ok: true;
      /** Filesystem-safe filename (`safe(label) [(N)].md`). */
      filename: string;
      /** The label as actually persisted, including any dedupe suffix. */
      label: string | null;
    }
  | {
      ok: false;
      reason: 'conflict';
      conflictWith: { id: string; filename: string };
    }
  | { ok: false; reason: 'duplicate'; files: string[] }
  | { ok: false; reason: 'not-found' };

/**
 * Node-sidecar operations only.
 *
 * This surface exists so `handle.nodes` cannot be widened, or cast, back into
 * the old all-purpose store: it must never grow a Space-record, log, title,
 * or lifecycle method. The Disk wrapper delegates each call to the legacy
 * object rather than re-exposing it.
 *
 * It is synchronous because the write coordinator's atomicity argument
 * depends on it: read → revision check → apply → write must stay `await`-free
 * inside the canvas lock. The async node phase replaces this only after
 * re-establishing that invariant.
 */
export interface LegacyNodeStore {
  readNode(nodeId: string): NodeContent | null;
  readAllNodes(options?: {
    strict?: boolean;
  }): Promise<Map<string, NodeContent>>;
  streamAllNodes(
    onNode: (id: string, content: NodeContent) => void,
    signal?: { readonly aborted: boolean },
  ): Promise<Map<string, NodeContent>>;
  writeNode(
    nodeId: string,
    content: NodeContent,
    opts?: { strictRename?: boolean },
  ): NodeWriteResult;
  deleteNode(nodeId: string): 'deleted' | 'absent';
  nodeIdForFilename(filename: string): string | null;
  isDuplicateNode(nodeId: string): boolean;
  duplicateNodeFiles(nodeId: string): string[];
  revalidateNodeForRead(nodeId: string): void;
  isNodeWriteSuppressed(nodeId: string): boolean;
}
