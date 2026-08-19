// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of the structured port.
 *
 * Builds a composite {@link SpaceHandle} on demand over the legacy per-Space
 * object that `getCanvasStore` already caches. It adds **no cache of its
 * own**: a second cache would have to be invalidated in lockstep with the
 * first, and `resetStorageCache()` — called on workspace switch — clears only
 * the legacy map, so a separately cached composite would survive a workspace
 * change still wrapping the previous workspace's object. The handle is a few
 * field assignments over an object the existing cache returns, so there is
 * nothing to gain by caching it twice.
 *
 * Because the record, log-backed, and node adapters all wrap the *same* legacy
 * object the compatibility facade resolves, a write through either view is
 * immediately observed through the other. That identity holds for as long as
 * the underlying cache entry lives, which is a bounded LRU — it is a
 * statement about consistency between the two views, not a promise that a
 * Space has one long-lived instance.
 */

import { getCanvasStore } from './legacy/canvas-store-cache.js';
import { createDiskSpaceLogs } from './space-logs.js';
import { DiskSpaceNodes } from './space-nodes.js';
import { createDiskSpaceRecordReader } from './space-record.js';
import { DiskSpaceRepository } from './space-repository.js';
import { DiskSpaceTasks } from './space-tasks.js';
import { createDiskSpaceWrite } from './space-write.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { StorageHealth } from '../../ports/common.js';
import type { SpaceHandle, StructuredStore } from '../../ports/structured.js';

export class DiskStructuredStore implements StructuredStore {
  readonly kind = 'disk' as const;

  readonly #workspacePath: string;

  /**
   * @param workspacePath Workspace this connection is mounted on. Defaults to
   *   the active one, which is what every caller outside the mount lifecycle
   *   means.
   *
   * The lifecycle passes it explicitly because a mount is staged *before* its
   * Workspace becomes active: `ensureWorld()` has to bootstrap the Workspace
   * being activated, not the one being replaced (proposal §12.6.5). The rest
   * of the adapter still resolves through the active-Workspace layout and
   * guards against a mismatch, so a staged connection is usable for bootstrap
   * and nothing else until the swap.
   */
  constructor(workspacePath: string = getWorkspacePath()) {
    this.#workspacePath = workspacePath;
  }

  async init(): Promise<void> {
    // The workspace directory is prepared by `workspace-prepare.ts`; Space
    // directories are created on demand by the lifecycle repository.
  }

  async health(): Promise<StorageHealth> {
    return { ok: true, kind: this.kind };
  }

  async close(): Promise<void> {}

  spaces(): DiskSpaceRepository {
    return new DiskSpaceRepository(this.#workspacePath);
  }

  space(canvasId: string): SpaceHandle {
    // `getCanvasStore` validates the id and owns the instance cache.
    const store = getCanvasStore(canvasId);
    const { events, changes } = createDiskSpaceLogs(store);
    return {
      canvasId: store.canvasId,
      read: createDiskSpaceRecordReader(store),
      write: createDiskSpaceWrite(store),
      nodes: new DiskSpaceNodes(store),
      changes,
      tasks: new DiskSpaceTasks(store),
      events,
    };
  }
}
