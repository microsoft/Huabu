/**
 * Chat Store
 *
 * Persists pi-ai Context objects as JSON files.
 * Storage layout: .history/<canvasId>/<threadId>.json
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { getWorkspacePath } from '../../workspace.js';

import type { Context } from '@mariozechner/pi-ai';

const HISTORY_DIR = '.history';
const DEFAULT_CANVAS = '_default';

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getCanvasDir(canvasId?: string): string {
  const canvas = sanitize(canvasId || DEFAULT_CANVAS);
  const dir = path.join(getWorkspacePath(), HISTORY_DIR, canvas);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getChatPath(canvasId: string | undefined, threadId: string): string {
  return path.join(getCanvasDir(canvasId), `${sanitize(threadId)}.json`);
}

/**
 * Save a pi-ai Context for a given thread.
 */
export function saveContext(
  threadId: string,
  context: Context,
  canvasId?: string,
): void {
  const filePath = getChatPath(canvasId, threadId);
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(context), 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Load a pi-ai Context for a given thread.
 * Returns null if no context exists.
 */
export function loadContext(
  threadId: string,
  canvasId?: string,
): Context | null {
  const filePath = getChatPath(canvasId, threadId);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Context;
  } catch {
    return null;
  }
}

/**
 * Find the most recently modified thread file in a canvas directory.
 * Returns { threadId, context } or null if no threads exist.
 */
export function loadLatestContext(
  canvasId?: string,
): { threadId: string; context: Context } | null {
  const dir = getCanvasDir(canvasId);

  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.startsWith('thread-') && f.endsWith('.json'),
    );
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  // Pick the most recently modified thread file
  let latest: { file: string; mtime: number } | null = null;
  for (const file of files) {
    try {
      const st = statSync(path.join(dir, file));
      if (!latest || st.mtimeMs > latest.mtime) {
        latest = { file, mtime: st.mtimeMs };
      }
    } catch {
      continue;
    }
  }

  if (!latest) return null;

  const threadId = latest.file.replace(/\.json$/, '');
  try {
    const raw = readFileSync(path.join(dir, latest.file), 'utf-8');
    return { threadId, context: JSON.parse(raw) as Context };
  } catch {
    return null;
  }
}
