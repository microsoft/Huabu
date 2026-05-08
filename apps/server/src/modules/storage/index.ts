/**
 * Storage module — public entry point.
 *
 * Provides the `CanvasStore` factory, workspace-wide canvas listing /
 * creation / deletion, and a small instance cache so repeated lookups
 * don't allocate.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { CanvasStore } from './canvas-store.js';
import { atomicWriteJson, mkdirp, sanitizeId } from './io.js';
import { canvasJsonPath, canvasRoot } from './paths.js';
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
}

// ─── Workspace-wide canvas operations ──────────────────────────────────────

/**
 * List every canvas in the workspace. Top-level subdirectories whose
 * name starts with `.` or that lack a `canvas.json` are skipped, so the
 * workspace root may also hold unrelated user folders.
 */
export function listCanvases(): CanvasFile[] {
  const ws = getWorkspacePath();
  if (!existsSync(ws)) return [];

  const out: CanvasFile[] = [];
  for (const entry of readdirSync(ws)) {
    if (entry.startsWith('.')) continue;
    const entryPath = path.join(ws, entry);
    let isDir = false;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const canvas = getCanvasStore(entry).read();
    if (canvas) out.push(canvas);
  }
  return out;
}

/**
 * Create an empty canvas folder + `canvas.json`. Returns null if the
 * canvas already exists.
 */
export function createCanvas(
  canvasId: string,
  title: string | null = null,
): CanvasFile | null {
  const safeId = sanitizeId(canvasId, 'canvasId');
  if (existsSync(canvasJsonPath(safeId))) return null;

  mkdirp(canvasRoot(safeId));
  const now = Date.now();
  const canvas: CanvasFile = {
    canvasId: safeId,
    title,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(canvasJsonPath(safeId), canvas);
  return canvas;
}

/**
 * Delete an entire canvas directory (`rm -rf <canvasId>/`). Returns
 * true when the directory existed.
 */
export function deleteCanvas(canvasId: string): boolean {
  const store = getCanvasStore(canvasId);
  const ok = store.destroy();
  cache.delete(store.canvasId);
  return ok;
}
