// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of {@link SpaceHandle.read}.
 *
 * Wraps the legacy per-Space object so reading `space.json` has a portable,
 * asynchronous contract. Record *writes* belong to `createDiskSpaceWrite`,
 * which owns the version check and the node/delta batch around it.
 */

import path from 'node:path';

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { canvasJsonPath } from './layout.js';
import { readValidCanvasFile } from './space-record-validation.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceHandle } from '../../ports/structured.js';

/**
 * Bind the record read for one Space handle.
 *
 * The workspace active at bind time is captured here, so a handle retained
 * across a workspace switch rejects rather than reading the newly active
 * workspace — the same guard the other Disk parts carry.
 */
export function createDiskSpaceRecordReader(
  store: CanvasStore,
): SpaceHandle['read'] {
  const workspacePath = path.resolve(getWorkspacePath());
  return async function readSpaceRecord(): Promise<CanvasFile | null> {
    if (path.resolve(getWorkspacePath()) !== workspacePath) {
      throw new Error(
        `Space record(${store.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
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
