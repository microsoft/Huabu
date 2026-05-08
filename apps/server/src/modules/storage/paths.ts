/**
 * Storage paths
 *
 * The single place that knows how the on-disk layout maps to canvas /
 * node / thread identifiers. Every other module composes paths via
 * these helpers.
 *
 * Layout under `<workspace>/`:
 *
 *   <canvasId>/
 *     canvas.json
 *     nodes/<nodeId>.md
 *     artifacts/<filename>
 *     memory/preferences.md
 *     .history/
 *       chat/<threadId>.json
 *       intent.json
 *       events.json
 */

import path from 'node:path';

import { sanitizeId } from './io.js';
import { getWorkspacePath } from '../workspace.js';

export function canvasRoot(canvasId: string): string {
  return path.join(getWorkspacePath(), sanitizeId(canvasId, 'canvasId'));
}

export function canvasJsonPath(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'canvas.json');
}

export function nodesDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'nodes');
}

export function nodeMdPath(canvasId: string, nodeId: string): string {
  return path.join(nodesDir(canvasId), `${sanitizeId(nodeId, 'nodeId')}.md`);
}

export function artifactsDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'artifacts');
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
