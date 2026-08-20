// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of {@link SpaceHandle.read}.
 *
 * Wraps the legacy per-Space object so reading `space.json` has a portable,
 * asynchronous contract. Record *writes* belong to `createDiskSpaceWrite`,
 * which owns the version check and the node/delta batch around it.
 */

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { canvasJsonPath } from './layout.js';
import { readValidCanvasFile } from './space-record-validation.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceHandle } from '../../ports/structured.js';

/**
 * Bind the record read for one Space handle.
 *
 * Shared by the handle and its extension member, so the existence check that
 * guards a substrate is the same read every other member answers to.
 */
export function createDiskSpaceRecordReader(
  store: CanvasStore,
): SpaceHandle['read'] {
  return async function readSpaceRecord(): Promise<CanvasFile | null> {
    return readDiskSpaceRecord(store);
  };
}

/**
 * Read and validate one record, refreshing the directory index once when the
 * indexed path is absent so externally renamed Spaces remain discoverable.
 * The already-parsed value is then reconciled by the compatibility store;
 * there is no second, lenient disk read that could hide corruption.
 */
export function readDiskSpaceRecord(store: CanvasStore): CanvasFile | null {
  let record = readValidCanvasFile(
    canvasJsonPath(store.canvasId),
    store.canvasId,
  );
  if (!record) {
    // Preserve Finder-rename recovery, but validate the newly indexed path
    // before the compatibility reader gets a chance to self-heal its title.
    refreshCanvasDirIndex();
    record = readValidCanvasFile(
      canvasJsonPath(store.canvasId),
      store.canvasId,
    );
  }
  if (!record) return null;
  return store.reconcileValidatedRecord(record);
}
