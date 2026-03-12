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
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { getCanvasDir } from '../workspace.js';

const DEFAULT_CANVAS_ID = 'default-canvas';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * On-disk shape of a canvas JSON file.
 */
export interface CanvasFile {
  canvasId: string;
  workspaceId: string | null;
  title: string | null;
  version: number;
  state: {
    nodes: unknown[];
    edges: unknown[];
    workspaceName?: string;
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
 * Ensure the default canvas file exists.
 * Called once at server startup.
 */
export function ensureDefaultCanvas(): void {
  const filePath = canvasFilePath(DEFAULT_CANVAS_ID);
  if (existsSync(filePath)) return;

  const now = Date.now();
  const defaultCanvas: CanvasFile = {
    canvasId: DEFAULT_CANVAS_ID,
    workspaceId: 'default',
    title: null,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(filePath, defaultCanvas);
}

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
