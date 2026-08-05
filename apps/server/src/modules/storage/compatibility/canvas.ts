/**
 * Compatibility facade — the current synchronous application storage API.
 *
 * This layer exists so Phase 2 can make the port/adapter side correct
 * without an `await` cascade through every consumer. It owns the surface the
 * application uses today: the `CanvasStore` factory and its cache, the Space
 * catalogue (list / summaries), and Space create / delete. Those are
 * aggregate lifecycle and catalogue concerns that have no portable contract
 * yet; see docs/proposals/multi-backend-storage.md §12.2.3.
 *
 * It delegates to the Disk legacy implementation directly rather than going
 * through `StructuredStore`, and both views resolve the *same* cached legacy
 * object, so a write through either is immediately visible through the other.
 *
 * This is also, deliberately, still a second **mutation entry point**. Until
 * its writers migrate, the repository CAS and log guarantees hold for calls
 * made through the repositories; they are not a global single-write-authority
 * guarantee for the running application.
 *
 * Nothing under `ports/` or `backends/` may import this file.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJson, mkdirp, sanitizeId } from '../../../utils/fs.js';
import {
  isWorldCanvasId,
  listCanvasDirEntries,
  refreshCanvasDirIndex,
  registerCanvasDir,
  suggestCanvasDir,
} from '../../workspace/disk/canvas-dirs.js';
import { toSafeFilename } from '../../workspace/disk/naming.js';
import {
  canvasJsonPath,
  SPACE_JSON_FILENAME,
} from '../../workspace/disk/paths.js';
import {
  acquireWorkspaceOperationLease,
  getWorkspacePath,
} from '../../workspace.js';
import {
  forgetCanvasStore,
  getCanvasStore,
} from '../backends/disk/legacy/canvas-store-cache.js';
import { canvasBlobs, withCanvasDeletionAdmission } from '../storage.js';

import type { CanvasFile } from '../../canvas/persistence-types.js';
import type { CanvasSummary } from '@sediment/shared';

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
 * Lightweight list of canvas summaries for the list endpoint.
 *
 * Unlike {@link listCanvases}, this builds each row straight from the
 * in-memory canvas-dir index — whose entries already carry the summary
 * fields (`nodeCount` / `createdAt` / `updatedAt`) captured when
 * `scanWorkspace()` parsed each topology file. That avoids re-reading
 * and re-parsing every canvas file a second time just to render the
 * list.
 *
 * The displayed `title` mirrors `CanvasStore.read`'s Finder-rename
 * self-heal (adopt the on-disk directory name when it diverges from the
 * sanitised title) but WITHOUT the write-back — a read path must not
 * mutate disk. Persisted topology is reconciled lazily the next
 * time the canvas is opened via `read()`.
 */
export function listCanvasSummaries(): CanvasSummary[] {
  const ws = getWorkspacePath();
  if (!existsSync(ws)) return [];
  // Re-scan so external file changes are reflected, matching listCanvases.
  refreshCanvasDirIndex();

  return listCanvasDirEntries().map((entry) => {
    const expectedDir = toSafeFilename(entry.title, entry.id);
    const title =
      entry.filename && entry.filename !== expectedDir
        ? entry.filename
        : entry.title;
    return {
      canvasId: entry.id,
      title,
      nodeCount: entry.nodeCount ?? 0,
      createdAt: entry.createdAt ?? 0,
      updatedAt: entry.updatedAt ?? 0,
    };
  });
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
  // Blob deletion can yield before the synchronous record destroy. Pin the
  // active workspace across both halves so a runtime workspace switch cannot
  // make them operate on different roots.
  const workspaceLease = acquireWorkspaceOperationLease();
  try {
    const store = getCanvasStore(canvasId);
    // `destroy()` refuses the World canvas too, but that check has to happen
    // before the blob sweep now that the sweep runs first — otherwise a
    // refused deletion would still have destroyed the World's bytes.
    if (isWorldCanvasId(store.canvasId)) {
      throw new Error('World canvas cannot be deleted');
    }
    return await withCanvasDeletionAdmission(store.canvasId, async () => {
      await canvasBlobs(store.canvasId).deleteAll();
      const ok = store.destroy();
      forgetCanvasStore(store.canvasId);
      return ok;
    });
  } finally {
    workspaceLease.release();
  }
}
