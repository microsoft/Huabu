// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of {@link SpaceRepository}.
 *
 * Wraps the legacy per-Space object with a portable asynchronous read path.
 * Mutation is intentionally available only through `DiskSpaceCommitter`.
 */

import path from 'node:path';

import { readValidCanvasFile } from './space-record-validation.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { canvasJsonPath } from '../../../workspace/disk/paths.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceRepository } from '../../ports/structured.js';

export class DiskSpaceRepository implements SpaceRepository {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  private assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `SpaceRepository(${this.#store.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }

  async read(): Promise<CanvasFile | null> {
    this.assertActiveWorkspace();
    return readDiskSpaceRecord(this.#store);
  }
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
