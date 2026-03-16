/**
 * Canvas File Store
 *
 * Replaces the SQLite-based canvas.db.ts with a JSON-file-based store.
 * Each canvas is stored as `<canvasDir>/<canvasId>.json`.
 *
 * Writes are atomic: write to a temp file first, then rename.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { getCanvasDir } from '../workspace.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * On-disk shape of a canvas JSON file.
 */
export interface CanvasFile {
  canvasId: string;
  title: string | null;
  version: number;
  state: {
    nodes: unknown[];
    edges: unknown[];
    [key: string]: unknown;
  };
  createdAt: number;
  updatedAt: number;
}

/**
 * Loose node type for processing unknown/untyped node structures.
 * Used when iterating over canvas state before validation.
 */
export interface NodeLike {
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Pattern for valid canvas IDs – alphanumeric, hyphens and underscores only. */
const CANVAS_ID_RE = /^[a-zA-Z0-9_-]+$/;

function canvasFilePath(canvasId: string): string {
  if (!CANVAS_ID_RE.test(canvasId)) {
    throw new Error(`Invalid canvasId: "${canvasId}"`);
  }
  return path.join(getCanvasDir(), `${canvasId}.json`);
}

/**
 * Atomic write: write to `.tmp` then rename, so readers never see a
 * partially-written file.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);

  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, filePath);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Read a canvas from disk. Returns null if not found.
 */
export function readCanvas(canvasId: string): CanvasFile | null {
  const filePath = canvasFilePath(canvasId);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as CanvasFile;
  } catch {
    return null;
  }
}

/**
 * Write a canvas to disk (atomic).
 */
export function writeCanvas(canvas: CanvasFile): void {
  const filePath = canvasFilePath(canvas.canvasId);
  atomicWriteJson(filePath, canvas);
}

/**
 * Read only the version number of a canvas (fast path for conflict checks).
 */
export function readCanvasVersion(canvasId: string): number | null {
  const canvas = readCanvas(canvasId);
  return canvas?.version ?? null;
}

/**
 * List all canvas files in the canvas directory.
 * Returns basic metadata without loading full state.
 */
export function listCanvases(): CanvasFile[] {
  const dir = getCanvasDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const canvases: CanvasFile[] = [];

  for (const file of files) {
    const canvasId = file.replace(/\.json$/, '');
    const canvas = readCanvas(canvasId);
    if (canvas) canvases.push(canvas);
  }

  return canvases;
}

/**
 * Create a new empty canvas with the given ID and optional title.
 * Returns the created canvas, or null if a canvas with that ID already exists.
 */
export function createCanvas(
  canvasId: string,
  title: string | null = null,
): CanvasFile | null {
  const filePath = canvasFilePath(canvasId);
  if (existsSync(filePath)) return null;

  const now = Date.now();
  const canvas: CanvasFile = {
    canvasId,
    title,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(filePath, canvas);
  return canvas;
}

/**
 * Delete a canvas file from disk.
 * Returns true if the file existed and was deleted, false otherwise.
 */
export function deleteCanvas(canvasId: string): boolean {
  const filePath = canvasFilePath(canvasId);
  if (!existsSync(filePath)) return false;

  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
