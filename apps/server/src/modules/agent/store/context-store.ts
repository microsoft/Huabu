/**
 * Context Store
 *
 * Persists pi-ai Context objects as JSON files, replacing LangGraph's
 * SQLite checkpoint system. Contexts are stored per thread ID.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { getWorkspacePath } from '../../workspace.js';

import type { Context } from '@mariozechner/pi-ai';

function getContextDir(): string {
  const dir = path.join(getWorkspacePath(), '.history');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getContextPath(threadId: string): string {
  // Sanitize threadId for filesystem safety
  const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getContextDir(), `${safe}.json`);
}

/**
 * Save a pi-ai Context for a given thread.
 */
export function saveContext(threadId: string, context: Context): void {
  const filePath = getContextPath(threadId);
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(context), 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Load a pi-ai Context for a given thread.
 * Returns null if no context exists.
 */
export function loadContext(threadId: string): Context | null {
  const filePath = getContextPath(threadId);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Context;
  } catch {
    return null;
  }
}
