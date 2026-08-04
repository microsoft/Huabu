/**
 * `CanvasStore` instance cache.
 *
 * Split out from `index.ts` so backend adapters can reach `getCanvasStore`
 * without importing the module's public entry point — which would make
 * `index.ts` → `storage.ts` → `backends/` → `index.ts` a cycle.
 */

import { CanvasStore } from './canvas-store.js';
import { sanitizeId } from '../../utils/fs.js';
import { refreshCanvasDirIndex } from '../workspace/disk/canvas-dirs.js';

const MAX_CACHE = 16;
const cache = new Map<string, CanvasStore>();

function rememberInstance(store: CanvasStore): CanvasStore {
  cache.delete(store.canvasId);
  cache.set(store.canvasId, store);
  if (cache.size > MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  return store;
}

/**
 * Get (or create) the `CanvasStore` for the given canvas id. Instances
 * are cheap; the cache only avoids re-validating ids on hot paths.
 */
export function getCanvasStore(canvasId: string): CanvasStore {
  const safeId = sanitizeId(canvasId, 'canvasId');
  const cached = cache.get(safeId);
  if (cached) {
    cache.delete(safeId);
    cache.set(safeId, cached);
    return cached;
  }
  return rememberInstance(new CanvasStore(safeId));
}

/** Drop a single cached instance. */
export function forgetCanvasStore(canvasId: string): void {
  cache.delete(canvasId);
}

/** Clear the instance cache. Call on workspace path changes. */
export function resetStorageCache(): void {
  cache.clear();
  refreshCanvasDirIndex();
}
