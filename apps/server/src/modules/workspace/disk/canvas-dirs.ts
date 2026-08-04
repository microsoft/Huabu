/**
 * Workspace-level canvas directory index.
 * Maps `canvasId` → on-disk directory name. Falls back to the id itself
 * when an entry is missing (legacy layout where dirName === canvasId).
 */

import { existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

import { NameIndex, type NameIndexResult } from './name-index.js';
import { dedupeName, normalizeForCompare, toSafeFilename } from './naming.js';
import { SPACE_JSON_FILENAME, WORLD_CANVAS_DIR_NAME } from './paths.js';
import { readJson, sanitizeId } from '../../../utils/fs.js';
import { getWorkspacePath } from '../../workspace.js';

export interface CanvasDirEntry {
  id: string;
  filename: string;
  title: string | null;
  /**
   * Summary fields captured during {@link
   * scanWorkspace} so the list endpoint can build its response without a
   * second read of every canvas file. Undefined for entries registered
   * via {@link registerCanvasDir} before the next workspace re-scan.
   */
  nodeCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

const index = new NameIndex<CanvasDirEntry>();
let worldEntry: CanvasDirEntry | null = null;
let scanned = false;

function readCanvasDirEntry(
  fullPath: string,
  filename: string,
  requireTopology = false,
): CanvasDirEntry | null {
  const json = readJson<{
    canvasId?: string;
    title?: string | null;
    state?: { nodes?: unknown[]; edges?: unknown[] };
    createdAt?: number;
    updatedAt?: number;
  }>(path.join(fullPath, SPACE_JSON_FILENAME));
  if (!json?.canvasId) return null;
  if (
    requireTopology &&
    (!Array.isArray(json.state?.nodes) || !Array.isArray(json.state?.edges))
  ) {
    return null;
  }
  if (requireTopology) sanitizeId(json.canvasId, 'world canvasId');
  return {
    id: json.canvasId,
    filename,
    title: json.title ?? null,
    nodeCount: Array.isArray(json.state?.nodes) ? json.state.nodes.length : 0,
    createdAt: typeof json.createdAt === 'number' ? json.createdAt : 0,
    updatedAt: typeof json.updatedAt === 'number' ? json.updatedAt : 0,
  };
}

function scanWorkspace(): void {
  index.reset([]);
  worldEntry = null;
  const ws = getWorkspacePath();
  if (!existsSync(ws)) {
    scanned = true;
    return;
  }

  const worldRoot = path.join(ws, WORLD_CANVAS_DIR_NAME);
  if (existsSync(worldRoot)) {
    try {
      if (!statSync(worldRoot).isDirectory()) {
        throw new Error('path is not a directory');
      }
    } catch (error) {
      throw new Error(
        `Invalid World canvas directory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    worldEntry = readCanvasDirEntry(worldRoot, WORLD_CANVAS_DIR_NAME, true);
    if (!worldEntry) {
      throw new Error(
        `World canvas is missing or malformed: ${path.join(
          worldRoot,
          SPACE_JSON_FILENAME,
        )}`,
      );
    }
  }

  for (const entry of readdirSync(ws)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(ws, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const canvasEntry = readCanvasDirEntry(full, entry);
    if (canvasEntry) index.add(canvasEntry);
  }
  if (worldEntry && index.has(worldEntry.id)) {
    throw new Error(
      `World canvasId duplicates an ordinary Space: ${worldEntry.id}`,
    );
  }
  scanned = true;
}

function ensureScanned(): void {
  if (!scanned) scanWorkspace();
}

/** Force a re-scan on next access (call after migrations / imports). */
export function refreshCanvasDirIndex(): void {
  scanned = false;
}

export function canvasDirName(canvasId: string): string {
  ensureScanned();
  if (worldEntry?.id === canvasId) return WORLD_CANVAS_DIR_NAME;
  return index.get(canvasId)?.filename ?? canvasId;
}

/** Ordinary user-visible Spaces only. */
export function listCanvasDirEntries(): CanvasDirEntry[] {
  ensureScanned();
  return index.list();
}

/** Every executable Canvas scope, including the hidden World. */
export function listAllCanvasDirEntries(): CanvasDirEntry[] {
  ensureScanned();
  return worldEntry ? [...index.list(), worldEntry] : index.list();
}

export function getWorldCanvasId(): string | null {
  ensureScanned();
  return worldEntry?.id ?? null;
}

export function requireWorldCanvasId(): string {
  const canvasId = getWorldCanvasId();
  if (!canvasId) {
    throw new Error('Configured workspace has no World canvas');
  }
  return canvasId;
}

export function isWorldCanvasId(canvasId: string): boolean {
  ensureScanned();
  return worldEntry?.id === canvasId;
}

/**
 * Suggest a directory name for a new canvas: sanitised title with a
 * numeric suffix on collision.
 */
export function suggestCanvasDir(
  title: string | null,
  fallback: string,
): string {
  ensureScanned();
  const base = toSafeFilename(title, fallback);
  return dedupeName(base, [
    ...index.list().map((entry) => entry.filename),
    WORLD_CANVAS_DIR_NAME,
  ]);
}

export function registerCanvasDir(
  canvasId: string,
  dirName: string,
  title: string | null,
): NameIndexResult<CanvasDirEntry> {
  ensureScanned();
  return index.add({ id: canvasId, filename: dirName, title });
}

export function patchCanvasDirTitle(
  canvasId: string,
  title: string | null,
): void {
  ensureScanned();
  index.patch(canvasId, { title });
}

export function unregisterCanvasDir(canvasId: string): void {
  ensureScanned();
  index.remove(canvasId);
}

/** Result of a strict on-disk rename. */
export type CanvasDirRenameResult =
  | { ok: true; dirName: string }
  | { ok: false; reason: 'conflict'; conflictWith: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'fs-error'; message: string };

/**
 * Rename a canvas directory both on disk and in the index. Same-slot
 * renames (case-only) update the stored casing without touching the
 * filesystem. Hard collisions return `{ ok: false, reason: 'conflict' }`.
 */
export function renameCanvasDirOnDisk(
  canvasId: string,
  newDirName: string,
): CanvasDirRenameResult {
  ensureScanned();
  const entry = index.get(canvasId);
  if (!entry) return { ok: false, reason: 'not-found' };

  if (
    worldEntry &&
    normalizeForCompare(worldEntry.filename) === normalizeForCompare(newDirName)
  ) {
    return { ok: false, reason: 'conflict', conflictWith: worldEntry.filename };
  }

  if (normalizeForCompare(entry.filename) === normalizeForCompare(newDirName)) {
    if (entry.filename !== newDirName) {
      // Case-only rename. Without a real `renameSync` the on-disk
      // basename keeps its old casing, so the next `scanWorkspace()`
      // (e.g. via `listCanvases()`) re-reads the original casing and
      // silently reverts the user's change. On case-insensitive
      // filesystems (APFS / NTFS) `renameSync` updates the casing in
      // place; on case-sensitive ones it's a regular rename.
      const ws = getWorkspacePath();
      const from = path.join(ws, entry.filename);
      const to = path.join(ws, newDirName);
      try {
        renameSync(from, to);
      } catch (err) {
        return {
          ok: false,
          reason: 'fs-error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      index.rename(canvasId, newDirName);
    }
    return { ok: true, dirName: newDirName };
  }

  const conflict = index.findByName(newDirName);
  if (conflict && conflict.id !== canvasId) {
    return { ok: false, reason: 'conflict', conflictWith: conflict.filename };
  }

  const ws = getWorkspacePath();
  const from = path.join(ws, entry.filename);
  const to = path.join(ws, newDirName);
  try {
    renameSync(from, to);
  } catch (err) {
    return {
      ok: false,
      reason: 'fs-error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  index.rename(canvasId, newDirName);
  return { ok: true, dirName: newDirName };
}
