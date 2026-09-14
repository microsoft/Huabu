// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Runtime validation shared by structured storage adapters. */

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Return the first minimal CanvasFile shape violation, if any. */
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
  if (!finiteNumber(record['version']))
    return 'version must be a finite number';
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
  if (!Array.isArray(stateRecord['nodes']))
    return 'state.nodes must be an array';
  if (!Array.isArray(stateRecord['edges']))
    return 'state.edges must be an array';
  return null;
}
