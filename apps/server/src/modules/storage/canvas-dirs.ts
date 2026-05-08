/**
 * Workspace-level canvas directory index.
 *
 * Maps stable `canvasId`s to the directory name used on disk. Built by
 * scanning every immediate subdirectory of the workspace for a
 * `canvas.json` and reading the `canvasId` field from inside.
 *
 * Read paths fall back to the canvas id itself when the index has no
 * entry (legacy layout where `dirName === canvasId`). This keeps the
 * refactor backwards compatible until the one-shot migration runs.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { readJson } from './io.js';
import { NameIndex, type NameIndexResult } from './name-index.js';
import { toSafeFilename } from './naming.js';
import { getWorkspacePath } from '../workspace.js';

export interface CanvasDirEntry {
  id: string;
  /** Directory name relative to the workspace root. */
  filename: string;
  title: string | null;
}

const index = new NameIndex<CanvasDirEntry>();
let scanned = false;

function scanWorkspace(): void {
  index.reset([]);
  const ws = getWorkspacePath();
  if (!existsSync(ws)) {
    scanned = true;
    return;
  }
  for (const entry of readdirSync(ws)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(ws, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const json = readJson<{ canvasId?: string; title?: string | null }>(
      path.join(full, 'canvas.json'),
    );
    if (!json?.canvasId) continue;
    index.add({
      id: json.canvasId,
      filename: entry,
      title: json.title ?? null,
    });
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

/**
 * Resolve a canvas id to its directory name. Falls back to the id
 * itself when the index has no entry (legacy directories whose name
 * already equals the canvas id remain readable).
 */
export function canvasDirName(canvasId: string): string {
  ensureScanned();
  return index.get(canvasId)?.filename ?? canvasId;
}

export function listCanvasDirEntries(): CanvasDirEntry[] {
  ensureScanned();
  return index.list();
}

export function findCanvasIdByDir(dirName: string): string | null {
  ensureScanned();
  return index.findByName(dirName)?.id ?? null;
}

/**
 * Suggest a directory name for a new canvas. Sanitises the requested
 * `title` and adds a numeric suffix on collision.
 */
export function suggestCanvasDir(
  title: string | null,
  fallback: string,
): string {
  ensureScanned();
  const base = toSafeFilename(title, fallback);
  return index.suggestUnique(base);
}

export function registerCanvasDir(
  canvasId: string,
  dirName: string,
  title: string | null,
): NameIndexResult<CanvasDirEntry> {
  ensureScanned();
  return index.add({ id: canvasId, filename: dirName, title });
}

export function renameCanvasDir(
  canvasId: string,
  newDirName: string,
): NameIndexResult<CanvasDirEntry> {
  ensureScanned();
  return index.rename(canvasId, newDirName);
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
