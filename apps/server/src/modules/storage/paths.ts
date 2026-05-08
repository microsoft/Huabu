/**
 * Storage paths
 *
 * The single place that knows how the on-disk layout maps to canvas /
 * node / thread identifiers. Every other module composes paths via
 * these helpers.
 *
 * Layout under `<workspace>/`:
 *
 *   <canvasDir>/                    ← name = sanitized canvas title
 *     canvas.json                   (carries the stable canvasId)
 *     nodes/<nodeFile>.md           ← name = sanitized node label
 *     artifacts/<filename>
 *     memory/preferences.md
 *     .history/
 *       chat/<threadId>.json
 *       intent.json
 *       events.json
 *
 * Stable identifiers (canvasId, nodeId) live inside the file payloads
 * (canvas.json, frontmatter), never as filenames. The directory and
 * file names are derived from user-facing labels via {@link
 * ./canvas-dirs.ts} and the per-canvas node index.
 */

import path from 'node:path';

import { canvasDirName } from './canvas-dirs.js';
import { sanitizeId } from './io.js';
import { getWorkspacePath } from '../workspace.js';

export function canvasRoot(canvasId: string): string {
  const safeId = sanitizeId(canvasId, 'canvasId');
  return path.join(getWorkspacePath(), canvasDirName(safeId));
}

export function canvasJsonPath(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'canvas.json');
}

export function nodesDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'nodes');
}

/**
 * Resolve a node markdown filename to an absolute path. The `filename`
 * argument is the user-facing label-derived name held in the per-canvas
 * node index, e.g. `My Note.md`.
 */
export function nodeFilePath(canvasId: string, filename: string): string {
  const base = path.basename(filename);
  if (!base || base === '.' || base === '..') {
    throw new Error(`Invalid node filename: "${filename}"`);
  }
  return path.join(nodesDir(canvasId), base);
}

export function artifactsDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'artifacts');
}

/**
 * Path of the per-canvas artifact manifest. Owned by `CanvasStore`,
 * created on first write.
 */
export function artifactManifestPath(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'artifacts.json');
}

/**
 * Resolve an artifact filename to an absolute path. The filename is
 * forced to its basename and validated against path traversal.
 */
export function artifactPath(canvasId: string, filename: string): string {
  const base = path.basename(filename);
  if (!base || base === '.' || base === '..') {
    throw new Error(`Invalid artifact filename: "${filename}"`);
  }
  return path.join(artifactsDir(canvasId), base);
}

export function memoryDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'memory');
}

export function prefsPath(canvasId: string): string {
  return path.join(memoryDir(canvasId), 'preferences.md');
}

export function historyDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), '.history');
}

export function chatDir(canvasId: string): string {
  return path.join(historyDir(canvasId), 'chat');
}

export function chatPath(canvasId: string, threadId: string): string {
  return path.join(
    chatDir(canvasId),
    `${sanitizeId(threadId, 'threadId')}.json`,
  );
}

export function intentPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'intent.json');
}

export function eventsPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'events.json');
}
