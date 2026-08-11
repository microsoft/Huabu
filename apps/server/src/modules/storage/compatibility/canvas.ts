// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Compatibility facade for remaining Disk-specific application capabilities.
 *
 * Phase 4 moved canonical structured mutation to `SpaceHandle.commit()` and
 * lifecycle to `StructuredStore.lifecycle()`. The old create/delete signatures
 * below are adapters over those portable services. `getCanvasStore` remains
 * for Disk reads and physical capabilities that later phases must model
 * explicitly (external files, RFS, import/export, and similar consumers).
 *
 * It delegates to the Disk legacy implementation directly rather than going
 * through `StructuredStore`, and both views resolve the *same* cached legacy
 * object, so a write through either is immediately visible through the other.
 *
 * The concrete legacy class still contains backend-private mutation codecs,
 * but production callers outside the Disk adapter are source-guarded from
 * invoking them. It is therefore compatibility surface, not a second running
 * application write authority.
 *
 * Nothing under `ports/` or `backends/` may import this file.
 */

import { existsSync } from 'node:fs';

import {
  listCanvasDirEntries,
  refreshCanvasDirIndex,
} from '../../workspace/disk/canvas-dirs.js';
import { getWorkspacePath } from '../../workspace.js';
import { getCanvasStore } from '../backends/disk/legacy/canvas-store-cache.js';
import { createSpace, deleteSpace } from '../storage.js';

import type { CanvasFile } from '../../canvas/persistence-types.js';

export { CanvasStore } from '../backends/disk/legacy/canvas-store.js';
export {
  forgetCanvasStore,
  getCanvasStore,
  resetStorageCache,
} from '../backends/disk/legacy/canvas-store-cache.js';
export type {
  RenameResult,
  RenameSelfResult,
} from '../backends/disk/legacy/canvas-store.js';

/**
 * List every canvas in the workspace.
 *
 * Iterates the in-memory canvas-dir index (built lazily on first
 * access). Each entry is paired with its persisted topology; rows
 * whose JSON has gone missing are skipped.
 */
export function listCanvases(): CanvasFile[] {
  const ws = getWorkspacePath();
  if (!existsSync(ws)) return [];
  // Always re-scan so external file changes (manual edits, imports,
  // migrations) are reflected here without forcing callers to invalidate.
  refreshCanvasDirIndex();

  const out: CanvasFile[] = [];
  for (const entry of listCanvasDirEntries()) {
    const canvas = getCanvasStore(entry.id).read();
    if (canvas) out.push(canvas);
  }
  return out;
}

/**
 * Create an empty Space with structural state. The directory is
 * named after a sanitised version of `title` (auto-deduped on
 * collision); the stable canvas id only appears inside the JSON.
 *
 * Returns null when a canvas with this id already exists.
 */
export async function createCanvas(
  canvasId: string,
  title: string | null = null,
): Promise<CanvasFile | null> {
  const result = await createSpace({ canvasId, title });
  return result.ok ? result.record : null;
}

/**
 * Delete an entire Space — both its blobs and its structured records.
 *
 * This is the composition point for Space deletion: the two stores are
 * independent, so neither can clean up the other.
 *
 * Blobs go first. Once the structured record is gone, nothing names the
 * Space's blobs any more, so a failure after that point would strand them
 * with no reference to retry from. On Disk the ordering is invisible — the
 * `.artifacts/` sweep is followed by removing the directory that contained
 * it — but on a remote blob backend it is the difference between a failed
 * delete the caller can retry and a permanent orphan. See
 * docs/proposals/multi-backend-storage.md §8.
 *
 * Returns true when the Space existed.
 */
export async function deleteCanvas(canvasId: string): Promise<boolean> {
  const result = await deleteSpace(canvasId);
  if (!result.ok && result.reason === 'world-forbidden') {
    throw new Error('World canvas cannot be deleted');
  }
  return result.ok;
}
