/**
 * Storage module — public entry point.
 *
 * Provides the `CanvasStore` factory, workspace-wide canvas listing /
 * creation / deletion, and a small instance cache so repeated lookups
 * don't allocate.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  listCanvasDirEntries,
  refreshCanvasDirIndex,
  registerCanvasDir,
  suggestCanvasDir,
} from './canvas-dirs.js';
import { CanvasStore } from './canvas-store.js';
import { atomicWriteJson, mkdirp, sanitizeId } from './io.js';
import { canvasJsonPath } from './paths.js';
import { getWorkspacePath } from '../workspace.js';

import type { CanvasFile } from './canvas-store.js';

export { CanvasStore } from './canvas-store.js';
export type {
  CanvasFile,
  CanvasEvent,
  NodeContent,
  NodeContentSummary,
  UserPreferences,
} from './canvas-store.js';

// ─── Instance cache (LRU-ish, max 16) ───────────────────────────────────────

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

/** Clear the instance cache. Call on workspace path changes. */
export function resetStorageCache(): void {
  cache.clear();
  refreshCanvasDirIndex();
}

// ─── Workspace-wide canvas operations ──────────────────────────────────────

/**
 * List every canvas in the workspace.
 *
 * Iterates the in-memory canvas-dir index (built lazily on first
 * access). Each entry is paired with its persisted `canvas.json`; rows
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
 * Create an empty canvas folder + `canvas.json`. The directory is
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

  const now = Date.now();
  const canvas: CanvasFile = {
    canvasId: safeId,
    title,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(path.join(dirPath, 'canvas.json'), canvas);
  registerCanvasDir(safeId, dirName, title);
  return canvas;
}

/**
 * Delete an entire canvas directory (`rm -rf <canvasDir>/`). Returns
 * true when the directory existed.
 */
export function deleteCanvas(canvasId: string): boolean {
  const store = getCanvasStore(canvasId);
  const ok = store.destroy();
  cache.delete(store.canvasId);
  return ok;
}
