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
 * Because the record, log-family, and node adapters all wrap the *same* legacy
 * object the compatibility facade resolves, a write through either view is
 * immediately observed through the other. That identity holds for as long as
 * the underlying cache entry lives, which is a bounded LRU — it is a
 * statement about consistency between the two views, not a promise that a
 * Space has one long-lived instance.
 */

import { createDiskCanvasLogRepositories } from './canvas-log-repository.js';
import { getCanvasStore } from './legacy/canvas-store-cache.js';
import { DiskLegacyNodeStore } from './legacy-node-store.js';
import { DiskSpaceRepository } from './space-repository.js';

import type { StorageHealth } from '../../ports/common.js';
import type { SpaceHandle, StructuredStore } from '../../ports/structured.js';

export class DiskStructuredStore implements StructuredStore {
  readonly kind = 'disk' as const;

  async init(): Promise<void> {
    // The workspace directory is prepared by `workspace-prepare.ts`; Space
    // directories are created on demand by `createCanvas`.
  }

  async health(): Promise<StorageHealth> {
    return { ok: true, kind: this.kind };
  }

  async close(): Promise<void> {}

  space(canvasId: string): SpaceHandle {
    // `getCanvasStore` validates the id and owns the instance cache.
    const store = getCanvasStore(canvasId);
    const logRepositories = createDiskCanvasLogRepositories(store);
    return {
      canvasId: store.canvasId,
      record: new DiskSpaceRepository(store),
      ...logRepositories,
      nodes: new DiskLegacyNodeStore(store),
    };
  }
}
