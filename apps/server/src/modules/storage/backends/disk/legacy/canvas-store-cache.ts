// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
import { currentWorkspaceScope } from '../../../../workspace/context.js';
import { getWorkspacePath } from '../../../../workspace.js';
import {
  refreshCanvasDirIndex,
  resetCanvasDirIndexes,
} from '../canvas-dirs.js';

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
 * Detect its effect here so a direct activation drops every cached instance,
 * whose node indexes may predate the switch, before the next handle is handed
 * out.
 *
 * Only a call outside any request's Workspace sees the process-active one.
 * Requests that work in several Workspaces at once (Bubble mode) share the
 * cache, keyed by folder, and never clear it for each other.
 */
function noticeProcessWorkspace(workspacePath: string): void {
  if (currentWorkspaceScope() !== undefined) return;
  if (cacheWorkspacePath === workspacePath) return;
  cache.clear();
  cacheWorkspacePath = workspacePath;
  refreshCanvasDirIndex(workspacePath);
}

/**
 * Get (or create) the `CanvasStore` for the given canvas id. Instances
 * are cheap; the cache only avoids re-validating ids on hot paths.
 */
export function getCanvasStore(canvasId: string): CanvasStore {
  const safeId = sanitizeId(canvasId, 'canvasId');
  const workspacePath = path.resolve(getWorkspacePath());
  noticeProcessWorkspace(workspacePath);
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
  let workspacePath: string;
  try {
    workspacePath = path.resolve(getWorkspacePath());
  } catch {
    return;
  }
  noticeProcessWorkspace(workspacePath);
  cache.delete(cacheKey(workspacePath, safeId));
}

/** Clear the instance cache and every folder's index explicitly. */
export function resetStorageCache(): void {
  cache.clear();
  resetCanvasDirIndexes();
}
