// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Compatibility facade for residual Disk reads and test fixtures.
 *
 * Production structured mutations use the portable repositories. The
 * `CanvasStore` factory remains temporarily available for Disk-specific read
 * capabilities that earlier phases did not migrate. `createCanvas` and
 * `deleteCanvas` remain direct-module test helpers; the public storage barrel
 * deliberately does not export them.
 *
 * It delegates to the Disk legacy implementation directly rather than going
 * through `StructuredStore`, and both views resolve the *same* cached legacy
 * object, so a write through either is immediately visible through the other.
 *
 * Nothing under `ports/` or `backends/` may import this file.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson, mkdirp, sanitizeId } from '../../../utils/fs.js';
import { toSafeFilename } from '../../../utils/naming.js';
import { getWorkspacePath } from '../../workspace.js';
import {
  listCanvasDirEntries,
  refreshCanvasDirIndex,
  registerCanvasDir,
  suggestCanvasDir,
} from '../backends/disk/canvas-dirs.js';
import {
  canvasJsonPath,
  SPACE_JSON_FILENAME,
} from '../backends/disk/layout.js';
import { getCanvasStore } from '../backends/disk/legacy/canvas-store-cache.js';
import { deleteSpace } from '../storage.js';

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
export function createCanvas(
  canvasId: string,
  title: string | null = null,
): CanvasFile | null {
  const safeId = sanitizeId(canvasId, 'canvasId');
  if (existsSync(canvasJsonPath(safeId))) return null;

  const dirName = suggestCanvasDir(title, safeId);
  const dirPath = path.join(getWorkspacePath(), dirName);
  mkdirp(dirPath);

  // If `dedupeName` appended a " (N)" suffix to avoid a collision, mirror
  // it into the persisted title so `read()`'s self-heal step (which copies
  // the on-disk basename back into `title`) does not later mutate the
  // user's chosen title behind their back.
  const safeFromTitle = toSafeFilename(title, safeId);
  const dedupeSuffix =
    dirName === safeFromTitle ? '' : dirName.slice(safeFromTitle.length);
  const resolvedTitle =
    title === null || dedupeSuffix === '' ? title : title + dedupeSuffix;

  const now = Date.now();
  const canvas: CanvasFile = {
    canvasId: safeId,
    title: resolvedTitle,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(path.join(dirPath, SPACE_JSON_FILENAME), canvas);
  registerCanvasDir(safeId, dirName, resolvedTitle);
  return canvas;
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
