/**
 * Blob storage port — opaque bytes, not application records.
 *
 * The connection ({@link BlobStore}) is the primary object; a
 * {@link BlobScope} is a bounded namespace derived from it. Blob storage is
 * not canvas-specific — canvas scoping is one derived view, and new scope
 * kinds extend {@link BlobScopeRef} without changing the connection.
 *
 * Artifact identity, ownership, MIME type, and lifecycle metadata are
 * structured records elsewhere; this port only moves bytes. Nothing here
 * exposes a permanent local path — see {@link BlobLease} for the one
 * bounded exception.
 *
 * See docs/proposals/multi-backend-storage.md §6.2.
 */

import type { StorageHealth } from './common.js';
import type { Readable } from 'node:stream';

export type BlobBackendKind = 'disk' | 'azure';

/**
 * Identifies a bounded namespace of blobs within a connection.
 *
 * A one-member union today. Adding a scope kind (workspace assets, agent
 * scratch) extends this type; the connection interface is unaffected.
 */
export type BlobScopeRef = { kind: 'canvas'; canvasId: string };

export interface BlobInfo {
  /** Scope-relative name, e.g. `artifact_abc123.png`. */
  name: string;
  size: number;
  mimeType: string | null;
  /** Last modification time, ms since epoch. */
  updatedAt: number;
}

export interface BlobPutOptions {
  mimeType?: string | null;
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
 * Disk returns its own storage path and releases as a no-op; remote
 * backends spool to a temp file and unlink on release. Use with
 * `try`/`finally` — the repo targets ES2020, so `await using` is not
 * available.
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
  put(
    name: string,
    body: Readable | Buffer,
    options?: BlobPutOptions,
  ): Promise<BlobInfo>;

  /** Metadata for one blob, or null when absent. */
  head(name: string): Promise<BlobInfo | null>;

  /** Open a stream over one blob, or null when absent. */
  open(name: string, range?: BlobRange): Promise<BlobRead | null>;

  /** Whole-blob read, or null when absent. */
  read(name: string): Promise<Buffer | null>;

  /**
   * Every blob in this scope.
   *
   * Exists so batch callers can answer many existence questions with one
   * round-trip instead of N — on a remote backend the difference is a
   * single list-by-prefix versus N requests.
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
