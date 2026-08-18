// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Declared filesystem materialization used by file-native product features. */

import type { StorageHealth } from './common.js';
import type { CanvasFile } from '../../canvas/persistence-types.js';

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
   * — a Disk layout answers it from the sidecar index, an id-addressed
   * projection from the name. A consumer that derived it from file *content*
   * would be reading this backend's record encoding, which is what the
   * capability exists to keep out of feature modules. `relativePath` is
   * Space-relative and uses `/` separators.
   */
  nodeIdForPath(relativePath: string): Promise<string | null>;
  /** Register a live native handle that must be released for rename/delete. */
  registerHandleOwner(owner: SpaceFileHandleOwner): () => void;
}

export interface SpaceImportStaging {
  readonly canvasId: string;
  readonly directory: string;
  /** Publish one imported record into the active materialization namespace. */
  publish(record: CanvasFile): Promise<CanvasFile>;
  /** Remove the unpublished staging directory. Idempotent after publish. */
  discard(): Promise<void>;
}

export interface SpaceFiles {
  readonly kind: 'disk';
  init(): Promise<void>;
  /** Refresh process-local materialization locators after Workspace commit. */
  activate(): void;
  health(): Promise<StorageHealth>;
  close(): Promise<void>;
  space(canvasId: string): SpaceFileScope;
  /** Allocate an isolated directory for one uploaded Space bundle. */
  stageImport(canvasId: string): Promise<SpaceImportStaging>;
}
