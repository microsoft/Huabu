/**
 * `CanvasStore` instance cache.
 *
 * The single owner of live legacy Disk instances. Both the Disk structured
 * adapter and the compatibility facade resolve Space objects through here, so
 * the two views never become separate in-memory authorities — a write through
 * one is immediately observed through the other.
 *
 * It sits beside the legacy class (rather than in the module barrel) so a
 * backend adapter can reach `getCanvasStore` without importing the module's
 * public entry point, which would make `index.ts` → `storage.ts` →
 * `backends/` → `index.ts` a cycle.
 *
 * The cache is a bounded LRU, so object identity across calls is not
 * promised: an entry can be evicted and rebuilt. Anything that must survive
 * eviction is either durable state in a repository or explicitly-scoped,
 * expiring coordination state such as node tombstones.
 */

import path from 'node:path';

import { CanvasStore } from './canvas-store.js';
import { sanitizeId } from '../../../../../utils/fs.js';
import { refreshCanvasDirIndex } from '../../../../workspace/disk/canvas-dirs.js';
import { getWorkspacePath } from '../../../../workspace.js';

const MAX_CACHE = 16;
const cache = new Map<string, CanvasStore>();
let cacheWorkspacePath: string | null = null;

function cacheKey(workspacePath: string, canvasId: string): string {
  // NUL is not legal in either an OS path or a validated canvas id.
  return `${workspacePath}\0${canvasId}`;
}

function rememberInstance(key: string, store: CanvasStore): CanvasStore {
  cache.delete(key);
  cache.set(key, store);
  if (cache.size > MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  return store;
}

/**
 * `setWorkspacePath()` intentionally knows nothing about storage backends.
 * Detect its effect here so even a direct activation invalidates all cached
 * per-workspace indexes before the next handle is handed out.
 */
function activateCacheWorkspace(workspacePath: string): void {
  if (cacheWorkspacePath === workspacePath) return;
  cache.clear();
  cacheWorkspacePath = workspacePath;
  // The directory index is process-global too. Refresh it before constructing
  // a handle so an id from the previous workspace cannot resolve through a
  // same-named directory in the newly-active one.
  refreshCanvasDirIndex();
}

/**
 * Get (or create) the `CanvasStore` for the given canvas id. Instances
 * are cheap; the cache only avoids re-validating ids on hot paths.
 */
export function getCanvasStore(canvasId: string): CanvasStore {
  const safeId = sanitizeId(canvasId, 'canvasId');
  const workspacePath = path.resolve(getWorkspacePath());
  activateCacheWorkspace(workspacePath);
  const key = cacheKey(workspacePath, safeId);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  return rememberInstance(key, new CanvasStore(safeId, workspacePath));
}

/** Drop a single cached instance. */
export function forgetCanvasStore(canvasId: string): void {
  const safeId = sanitizeId(canvasId, 'canvasId');
  // Before first activation there cannot be an instance to forget, and
  // `getWorkspacePath()` deliberately throws. Keep cleanup harmless during
  // boot without weakening get/create operations.
  if (cacheWorkspacePath === null) return;
  const workspacePath = path.resolve(getWorkspacePath());
  activateCacheWorkspace(workspacePath);
  cache.delete(cacheKey(workspacePath, safeId));
}

/** Clear the instance cache explicitly (workspace changes are auto-detected). */
export function resetStorageCache(): void {
  cache.clear();
  // Initial null is also the pre-Workspace state. `commitWorkspacePath()`
  // refreshes the directory index when the first Workspace is activated, so
  // there is nothing further to invalidate here.
  if (cacheWorkspacePath === null) return;
  cacheWorkspacePath = path.resolve(getWorkspacePath());
  refreshCanvasDirIndex();
}
