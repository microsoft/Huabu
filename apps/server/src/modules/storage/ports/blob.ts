// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Blob storage port — opaque bytes, not application records.
 *
 * The connection ({@link BlobStore}) is the primary object; a
 * {@link BlobScope} is a bounded namespace derived from it. Blob storage is
 * not canvas-specific — canvas scoping is one derived view, and new scope
 * kinds extend {@link BlobScopeRef} without changing the connection.
 *
 * Artifact identity, ownership, MIME representation, and lifecycle are
 * application concerns; this port only moves bytes. Today the HTTP boundary
 * infers MIME from the blob name, matching the previous `sendFile()` behavior.
 * Nothing here exposes a permanent local path — see {@link BlobLease} for the
 * one bounded exception.
 *
 * See docs/proposals/multi-backend-storage.md §6.2.
 */

import type { StorageHealth } from './common.js';
import type { Readable } from 'node:stream';

export type BlobBackendKind = 'disk' | 'azure';

/**
 * Identifies a bounded namespace of blobs within a connection.
 *
 * One kind per **user-visible area**, not one per Space. That distinction is
 * what keeps names flat: a Space's bytes live in several places a user can
 * tell apart — the artifacts the app writes, the guide they author, the memory
 * the agent keeps, the scratch an upload lands in — and the alternative to
 * naming those areas is hierarchical blob names, which §7.1 excluded for every
 * backend. A kind is a union member and one placement rule per adapter; a path
 * separator inside a name is a contract change.
 *
 * It also lets retention diverge later — scratch is not an artifact — without
 * moving any bytes a second time.
 *
 * Adding a scope with no Space (workspace assets, agent scratch) extends this
 * type the same way; the connection interface is unaffected.
 */
export type BlobScopeRef =
  /** Artifacts the application writes and the client fetches by key. */
  | { kind: 'space-artifacts'; canvasId: string }
  /**
   * User-authored guide documents at the Space root.
   *
   * Bounded by {@link SPACE_GUIDE_BLOB_NAMES} rather than by a directory,
   * because the area a user authors in *is* the Space root — which also holds
   * storage's own record. A scope that claimed the whole directory would list
   * `space.json` and delete the Space on `deleteAll()`. Naming the members is
   * what makes the boundary real, and a fixed set is a tighter namespace than
   * a directory, not a looser one.
   */
  | { kind: 'space-guide'; canvasId: string }
  /** The agent's private memory document for a Space. */
  | { kind: 'space-memory'; canvasId: string }
  /** Scratch an upload lands in before anything claims it. */
  | { kind: 'space-upload'; canvasId: string };

/**
 * Every blob name the `space-guide` scope may hold.
 *
 * Product vocabulary rather than adapter detail: these are the documents a
 * user is invited to author at the Space root, so the set belongs beside the
 * scope it defines.
 */
export const SPACE_GUIDE_SKILL_NAME = 'skill.md';

export const SPACE_GUIDE_BLOB_NAMES: readonly string[] = [
  SPACE_GUIDE_SKILL_NAME,
];

/** The one blob in the `space-memory` scope: the agent's memory document. */
export const SPACE_MEMORY_BLOB_NAME = 'space.md';

/**
 * Every scope holding bytes for one Space.
 *
 * Deletion has to sweep all of them, and a kind added without being swept
 * would orphan bytes on a backend where dropping the Space does not remove
 * the area they sit in. Derived here so the saga cannot fall behind the union.
 */
export function spaceBlobScopes(canvasId: string): readonly BlobScopeRef[] {
  return [
    { kind: 'space-artifacts', canvasId },
    { kind: 'space-guide', canvasId },
    { kind: 'space-memory', canvasId },
    { kind: 'space-upload', canvasId },
  ];
}

export interface BlobInfo {
  /** Scope-relative name, e.g. `artifact_abc123.png`. */
  name: string;
  size: number;
  /** Last modification time, ms since epoch. */
  updatedAt: number;
}

/** Inclusive byte offsets, matching HTTP Range semantics. */
export interface BlobRange {
  start?: number;
  end?: number;
}

export interface BlobRead {
  info: BlobInfo;
  body: Readable;
}

/**
 * A temporary real filesystem path for a blob, valid only until
 * {@link release} resolves.
 *
 * Only for consumers that hand a path to code we don't control (document
 * loaders, external binaries). Everything else should take bytes via
 * {@link BlobScope.read} or {@link BlobScope.open}.
 *
 * Two rules make the lease mean the same thing on every backend, because
 * this is where adapters would otherwise diverge invisibly:
 *
 * 1. **The path is read-only.** Writing through it corrupts authoritative
 *    bytes on Disk and silently mutates a doomed temp copy on a remote
 *    backend. Neither is a supported operation.
 * 2. **The path is invalid once {@link release} resolves.** Disk physically
 *    keeps its file — the path *is* its storage — so reading a retained copy
 *    of the string would keep working there and fail on a remote backend.
 *    Accessing {@link path} after release therefore throws on every backend,
 *    so the stronger Disk behavior can't be depended on by accident.
 *
 * Use with `try`/`finally` — the repo targets ES2020, so `await using` is
 * not available. Build leases with {@link createBlobLease} rather than an
 * object literal, so both rules hold without each adapter restating them.
 */
export interface BlobLease {
  readonly path: string;
  release(): Promise<void>;
}

/**
 * A bounded namespace of blobs — the read/write surface.
 *
 * `name` is a single path segment. Implementations normalize with
 * `path.basename()` and reject empty, `.`, and `..`, matching the contract
 * the disk layout has always enforced.
 */
export interface BlobScope {
  put(name: string, body: Readable | Buffer): Promise<BlobInfo>;

  /** Metadata for one blob, or null when absent. */
  head(name: string): Promise<BlobInfo | null>;

  /** Open a stream over one blob, or null when absent. */
  open(name: string, range?: BlobRange): Promise<BlobRead | null>;

  /** Whole-blob read, or null when absent. */
  read(name: string): Promise<Buffer | null>;

  /**
   * Return the normalized names that exist from a caller-supplied batch.
   *
   * Unlike {@link list}, this does not enumerate unrelated blobs. Callers
   * that already know the keys they care about should use this method so a
   * remote implementation can issue one bounded batch request.
   */
  hasMany(names: readonly string[]): Promise<ReadonlySet<string>>;

  /**
   * Every blob in this scope.
   */
  list(): Promise<BlobInfo[]>;

  /** A temporary real path for this blob, or null when absent. */
  materialize(name: string): Promise<BlobLease | null>;

  /**
   * Remove every blob in this scope.
   *
   * The only deletion this port offers, because deleting a Space is the
   * only deletion the application performs today. Per-key deletion needs a
   * reference-counting and GC design that is still open.
   */
  deleteAll(): Promise<void>;
}

/** A connection to a blob backend. Process-wide; scopes are derived. */
export interface BlobStore {
  readonly kind: BlobBackendKind;
  init(): Promise<void>;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  scope(ref: BlobScopeRef): BlobScope;
}

/** Thrown when a blob name is not a usable single path segment. */
export class BlobNameError extends Error {
  override name = 'BlobNameError';
}

/** Thrown when a released {@link BlobLease}'s path is used. */
export class BlobLeaseError extends Error {
  override name = 'BlobLeaseError';
}

/**
 * Build a lease with the semantics {@link BlobLease} promises.
 *
 * Shared by every adapter for the same reason as {@link normalizeBlobName}:
 * the behavior must not drift between backends. `onRelease` is whatever the
 * adapter has to do to give the path back — nothing for Disk, an unlink for a
 * backend that spooled a temp copy — and runs at most once.
 */
export function createBlobLease(
  path: string,
  onRelease: () => Promise<void>,
): BlobLease {
  let released = false;
  return {
    get path(): string {
      if (released) {
        throw new BlobLeaseError(
          'Blob lease has been released; materialize() again for a fresh path',
        );
      }
      return path;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await onRelease();
    },
  };
}

/**
 * Normalize a caller-supplied blob name to a single safe segment.
 *
 * Shared by every adapter so name semantics can't drift between backends.
 * Mirrors `paths.ts::artifactPath()`: take the basename, reject the three
 * values that don't denote a file.
 */
export function normalizeBlobName(name: string): string {
  const base = name.split('/').pop()?.split('\\').pop() ?? '';
  if (!base || base === '.' || base === '..') {
    throw new BlobNameError(`Invalid blob name: "${name}"`);
  }
  return base;
}
