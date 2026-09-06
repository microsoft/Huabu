// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Movement of persisted values between domain records and SQLite rows.
 *
 * Every column this backend stores is either JSON text or a scalar, so the
 * codecs here are the single place that decides what a well-formed stored
 * value looks like. Space and log reads reject malformed domain values. Node
 * reads preserve the port's repair path by recovering malformed JSON values
 * into a valid record whose content still exposes the stored value.
 */

import { SQLITE_WORLD_COLLISION_KEY } from './database.js';
import { canvasFileShapeError } from '../../../canvas/persistence-validation.js';

import type {
  CanvasFile,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type { DatabaseSync } from 'node:sqlite';

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function assertJsonValue(
  value: unknown,
  context: string,
  seen: Set<object>,
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${context} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${context} contains a non-JSON value`);
  }
  if (seen.has(value)) throw new TypeError(`${context} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError(`${context} contains a sparse array`);
        }
        assertJsonValue(value[index], `${context}[${index}]`, seen);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${context} contains a non-plain object`);
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${context}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function stringifyJson(value: unknown, context: string): string {
  assertJsonValue(value, context, new Set());
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError(`${context} is not representable as JSON`);
  }
  return encoded;
}

export function parseJson(value: unknown, context: string): unknown {
  if (typeof value !== 'string') {
    throw new SyntaxError(`${context} is not stored as JSON text`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new SyntaxError(
      `Invalid JSON in ${context}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function rowObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError(`Missing or malformed SQLite row for ${context}`);
  }
  return value as Record<string, unknown>;
}

function stringColumn(
  row: Record<string, unknown>,
  column: string,
  context: string,
): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new SyntaxError(`Invalid ${column} in ${context}`);
  }
  return value;
}

function nullableStringColumn(
  row: Record<string, unknown>,
  column: string,
  context: string,
): string | null {
  const value = row[column];
  if (value !== null && typeof value !== 'string') {
    throw new SyntaxError(`Invalid ${column} in ${context}`);
  }
  return value;
}

function numberColumn(
  row: Record<string, unknown>,
  column: string,
  context: string,
): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SyntaxError(`Invalid ${column} in ${context}`);
  }
  return value;
}

export interface PersistedSpace {
  readonly record: CanvasFile;
  readonly collisionKey: string;
  readonly isWorld: boolean;
}

export function decodeSpaceRow(value: unknown): PersistedSpace {
  const row = rowObject(value, 'Space');
  const canvasId = stringColumn(row, 'canvas_id', 'Space');
  const context = `Space ${JSON.stringify(canvasId)}`;
  const record: CanvasFile = {
    canvasId,
    title: nullableStringColumn(row, 'title', context),
    version: numberColumn(row, 'version', context),
    state: parseJson(
      row['state_json'],
      `${context} state`,
    ) as CanvasFile['state'],
    createdAt: numberColumn(row, 'created_at', context),
    updatedAt: numberColumn(row, 'updated_at', context),
  };
  const shapeError = canvasFileShapeError(record, canvasId);
  if (shapeError) throw new SyntaxError(`Invalid ${context}: ${shapeError}`);
  const world = numberColumn(row, 'is_world', context);
  if (world !== 0 && world !== 1) {
    throw new SyntaxError(`Invalid is_world in ${context}`);
  }
  return {
    record,
    collisionKey: stringColumn(row, 'collision_key', context),
    isWorld: world === 1,
  };
}

export const SPACE_COLUMNS =
  'canvas_id, title, collision_key, version, state_json, created_at, updated_at, is_world';

export function readSpaceRow(
  database: DatabaseSync,
  canvasId: string,
): PersistedSpace | null {
  const row = database
    .prepare(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE canvas_id = ?`)
    .get(canvasId);
  return row === undefined ? null : decodeSpaceRow(row);
}

export function validateCanvasFile(record: CanvasFile, canvasId: string): void {
  const shapeError = canvasFileShapeError(record, canvasId);
  if (shapeError) {
    throw new TypeError(`Invalid Space record: ${shapeError}`);
  }
  stringifyJson(record.state, `Space ${JSON.stringify(canvasId)} state`);
}

export function insertSpaceRow(
  database: DatabaseSync,
  record: CanvasFile,
  collisionKey: string,
  isWorld = false,
): void {
  validateCanvasFile(record, record.canvasId);
  database
    .prepare(
      `INSERT INTO spaces (
        canvas_id, title, collision_key, version, state_json,
        created_at, updated_at, is_world
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.canvasId,
      record.title,
      isWorld ? SQLITE_WORLD_COLLISION_KEY : collisionKey,
      record.version,
      stringifyJson(record.state, `Space ${record.canvasId} state`),
      record.createdAt,
      record.updatedAt,
      isWorld ? 1 : 0,
    );
}

export function updateSpaceRow(
  database: DatabaseSync,
  record: CanvasFile,
  expectedVersion: number,
): number {
  validateCanvasFile(record, record.canvasId);
  const result = database
    .prepare(
      `UPDATE spaces
       SET version = ?, state_json = ?, updated_at = ?
       WHERE canvas_id = ? AND version = ?`,
    )
    .run(
      record.version,
      stringifyJson(record.state, `Space ${record.canvasId} state`),
      record.updatedAt,
      record.canvasId,
      expectedVersion,
    );
  return Number(result.changes);
}

export function validateNodeContent(
  record: NodeContent,
  expectedNodeId: string,
): void {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new TypeError('Node record must be an object');
  }
  if (record.nodeId !== expectedNodeId) {
    throw new Error(
      `Node id mismatch: argument=${JSON.stringify(expectedNodeId)} ` +
        `record=${JSON.stringify(record.nodeId)}`,
    );
  }
  if (typeof record.type !== 'string') {
    throw new TypeError('Node record type must be a string');
  }
  if (record.label !== null && typeof record.label !== 'string') {
    throw new TypeError('Node record label must be a string or null');
  }
  if (typeof record.content !== 'string') {
    throw new TypeError('Node record content must be a string');
  }
  stringifyJson(record, `Node ${JSON.stringify(expectedNodeId)} record`);
}

export function decodeNodeRecord(
  value: unknown,
  expectedNodeId: string,
): NodeContent {
  const parsed = parseJson(value, `Node ${JSON.stringify(expectedNodeId)}`);
  try {
    validateNodeContent(parsed as NodeContent, expectedNodeId);
    return parsed as NodeContent;
  } catch {
    // A valid JSON value can still have a damaged Node shape after an
    // out-of-band database edit. Keep it reachable so a normal put can repair
    // it, matching the lenient content rule used by the Disk adapter.
    const fields =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return {
      ...fields,
      nodeId: expectedNodeId,
      type: typeof fields['type'] === 'string' ? fields['type'] : 'note',
      label: typeof fields['label'] === 'string' ? fields['label'] : null,
      content:
        typeof fields['content'] === 'string'
          ? fields['content']
          : stringifyJson(parsed, `Malformed Node ${expectedNodeId}`),
    } as NodeContent;
  }
}

export function requireRevision(value: unknown, nodeId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SyntaxError(
      `Invalid persisted revision for Node ${JSON.stringify(nodeId)}`,
    );
  }
  return value;
}
