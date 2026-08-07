/** Runtime validation shared by strict Disk Space-record boundaries. */

import { readJsonStrict } from '../../../../utils/fs.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Return the first minimal {@link CanvasFile} shape violation, if any. */
export function canvasFileShapeError(
  value: unknown,
  expectedCanvasId: string,
): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be an object';
  }

  const record = value as Record<string, unknown>;
  if (record['canvasId'] !== expectedCanvasId) {
    return `canvasId must equal ${JSON.stringify(expectedCanvasId)}`;
  }
  if (record['title'] !== null && typeof record['title'] !== 'string') {
    return 'title must be a string or null';
  }
  if (!finiteNumber(record['version'])) {
    return 'version must be a finite number';
  }
  if (!finiteNumber(record['createdAt'])) {
    return 'createdAt must be a finite number';
  }
  if (!finiteNumber(record['updatedAt'])) {
    return 'updatedAt must be a finite number';
  }

  const state = record['state'];
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return 'state must be an object';
  }
  const stateRecord = state as Record<string, unknown>;
  if (!Array.isArray(stateRecord['nodes'])) {
    return 'state.nodes must be an array';
  }
  if (!Array.isArray(stateRecord['edges'])) {
    return 'state.edges must be an array';
  }
  return null;
}

/**
 * Strictly read and validate one indexed `space.json` path.
 *
 * Only absence returns null. Invalid JSON, IO failures, shape violations,
 * and a record belonging to another Space reject before any self-heal can
 * rewrite the file.
 */
export function readValidCanvasFile(
  filePath: string,
  expectedCanvasId: string,
): CanvasFile | null {
  const parsed = readJsonStrict<unknown>(filePath);
  if (parsed === null) return null;

  const shapeError = canvasFileShapeError(parsed, expectedCanvasId);
  if (shapeError) {
    throw new SyntaxError(`Invalid Space record in ${filePath}: ${shapeError}`);
  }
  return parsed as CanvasFile;
}
