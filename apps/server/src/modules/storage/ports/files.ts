// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Declared filesystem materialization used by file-native product features.
 *
 * Some product requirements are genuinely about files, not records: an ACP
 * agent needs a working directory, RFS exposes a tree, the external-note
 * watcher needs something to watch, a bundle is a directory of real files.
 * That is a requirement rather than a leak (proposal §12.5.4), but it still
 * has to be one declared capability rather than every feature module knowing
 * one backend's layout.
 *
 * The axis is **how a Space's directory is addressed**, because that is what
 * differs between deployments and what binds a materialization to the
 * structured records:
 *
 * - `disk-titled` files a Space under its title and moves that directory when
 *   the title changes. It is the user-visible Finder layout Huabu ships, and
 *   it can only resolve a locator by consulting the structured records that
 *   carry those titles — which is exactly why it is only coherent beside the
 *   Disk structured backend.
 * - `disk-addressed` files a Space under its stable id. It needs nothing but
 *   the id, so it composes with any structured backend, at the cost of
 *   directory names that mean nothing to a human browsing the Workspace.
 *
 * `profile.ts` owns choosing between them and rejecting an incoherent
 * pairing; this file owns what either one must do.
 */

import type { StorageHealth } from './common.js';
import type { CanvasFile } from '../../canvas/persistence-types.js';

/**
 * Materializations with an implementation today.
 *
 * Both are the local filesystem — they differ in addressing, not substrate,
 * which is why neither name is a storage vendor.
 */
export type SpaceFilesKind = 'disk-titled' | 'disk-addressed';

export interface SpaceFileHandleOwner {
  release(): Promise<void> | void;
  reacquire(): Promise<void> | void;
}

export interface SpaceFileScope {
  readonly canvasId: string;
  /** Absolute root of this Space's materialized filesystem view. */
  directory(): string;
  /** Absolute path to the materialized node-record directory. */
  nodesDirectory(): string;
  /**
   * The node record a materialized file carries, or null when none does.
   *
   * Which file stands for which record is the materialization's own business
   * — a title-addressed layout answers it from the sidecar index, an
   * id-addressed one from the name. A consumer that derived it from file
   * *content* would be reading the backend's record encoding, which is what
   * this capability exists to keep out of feature modules. `relativePath` is
   * Space-relative and uses `/` separators.
   */
  nodeIdForPath(relativePath: string): Promise<string | null>;
  /** Register a live native handle that must be released for rename/delete. */
  registerHandleOwner(owner: SpaceFileHandleOwner): () => void;
}

export interface SpaceImportStaging {
  readonly canvasId: string;
  readonly directory: string;
  /**
   * Adopt the staged directory as this Space's materialization.
   *
   * Returns the record as materialized. A title-addressed implementation may
   * hand back an adjusted title, because the directory it has to allocate is
   * derived from that title and the name may already be taken; an addressed
   * one returns the record unchanged. Callers must therefore use the returned
   * record rather than the one they passed in.
   *
   * Placing the files is all this promises. Whether the structured record
   * also becomes readable as a side effect is the backend's business — for a
   * title-addressed Disk layout the published directory *is* the record.
   */
  publish(record: CanvasFile): Promise<CanvasFile>;
  /** Remove the unpublished staging directory. Idempotent after publish. */
  discard(): Promise<void>;
}

export interface SpaceFiles {
  readonly kind: SpaceFilesKind;
  init(): Promise<void>;
  /**
   * Refresh process-local materialization locators after a Workspace commit.
   *
   * Called once, after the new Workspace path is committed and before the
   * mount is swapped in. It must perform no fallible work: everything that
   * can fail belongs in `init()`, which runs while the mount is still staged
   * and can still be abandoned.
   */
  activate(): void;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  space(canvasId: string): SpaceFileScope;
  /** Allocate an isolated directory for one uploaded Space bundle. */
  stageImport(canvasId: string): Promise<SpaceImportStaging>;
}
