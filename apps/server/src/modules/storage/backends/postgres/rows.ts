// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { SQL_WORLD_COLLISION_KEY } from './database.js';
import {
  decodeSpaceRow,
  SPACE_COLUMNS,
  stringifyJson,
  validateCanvasFile,
} from '../sql/codecs.js';
/**
 * Movement of persisted values between domain records and Postgres rows.
 *
 * Every column this backend stores is either JSON text or a scalar, so the
 * codecs here are the single place that decides what a well-formed stored
 * value looks like. Space and log reads reject malformed domain values. Node
 * reads preserve the port's repair path by recovering malformed JSON values
 * into a valid record whose content still exposes the stored value.
 *
 * The encoder's job is to refuse what Postgres could not faithfully return —
 * cycles, non-finite numbers, values `JSON.stringify` would silently reshape
 * into something else. It deliberately does **not** refuse what
 * `JSON.stringify` already handles by rule, because Disk persists through
 * that same function: a record it accepts must not become a rejected write
 * here. `undefined` is the case that matters in practice — an optional field
 * spread onto a node makes an own property whose value is `undefined`, and
 * Disk drops it. See §13's "silent divergence" risk: a portable contract that
 * only holds where the adapters already agree certifies both sides of a
 * disagreement.
 */

import type { PgExecutor } from './database.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { PersistedSpace } from '../sql/codecs.js';

/**
 * Read one Space, scoped to the Workspace that owns it.
 *
 * The Workspace predicate is not an optimization. `canvas_id` is unique across
 * the whole database, so without it a handle resolved in one Workspace would
 * answer for a Space in another — which is exactly the confusion the Disk
 * adapters prevent by binding to a workspace path.
 */
export async function readSpaceRow(
  database: PgExecutor,
  workspaceId: string,
  canvasId: string,
): Promise<PersistedSpace | null> {
  const row = await database.get(
    `SELECT ${SPACE_COLUMNS}
       FROM spaces
       WHERE workspace_id = ? AND canvas_id = ?`,
    workspaceId,
    canvasId,
  );
  return row === undefined ? null : decodeSpaceRow(row);
}

/** Whether the named Space exists in this Workspace. */
export async function spaceRowExists(
  database: PgExecutor,
  workspaceId: string,
  canvasId: string,
): Promise<boolean> {
  return (
    (
      await database.get(
        `SELECT 1 AS present
         FROM spaces
         WHERE workspace_id = ? AND canvas_id = ?`,
        workspaceId,
        canvasId,
      )
    )?.['present'] === 1
  );
}

/** Collision keys already taken in one Workspace, for name allocation. */
export async function occupiedCollisionKeys(
  database: PgExecutor,
  workspaceId: string,
): Promise<string[]> {
  return (
    await database.all(
      'SELECT collision_key FROM spaces WHERE workspace_id = ?',
      workspaceId,
    )
  )
    .map((row) => row['collision_key'])
    .filter((value): value is string => typeof value === 'string');
}

export async function insertSpaceRow(
  database: PgExecutor,
  workspaceId: string,
  record: CanvasFile,
  collisionKey: string,
  isWorld = false,
): Promise<void> {
  validateCanvasFile(record, record.canvasId);
  await database.run(
    `INSERT INTO spaces (
        canvas_id, workspace_id, title, collision_key, version, state_json,
        created_at, updated_at, is_world
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.canvasId,
    workspaceId,
    record.title,
    isWorld ? SQL_WORLD_COLLISION_KEY : collisionKey,
    record.version,
    stringifyJson(record.state, `Space ${record.canvasId} state`),
    record.createdAt,
    record.updatedAt,
    isWorld ? 1 : 0,
  );
}

export async function updateSpaceRow(
  database: PgExecutor,
  workspaceId: string,
  record: CanvasFile,
  expectedVersion: number,
): Promise<number> {
  validateCanvasFile(record, record.canvasId);
  const result = await database.run(
    `UPDATE spaces
       SET version = ?, state_json = ?, updated_at = ?
       WHERE workspace_id = ? AND canvas_id = ? AND version = ?`,
    record.version,
    stringifyJson(record.state, `Space ${record.canvasId} state`),
    record.updatedAt,
    workspaceId,
    record.canvasId,
    expectedVersion,
  );
  return Number(result.changes);
}

export {
  decodeNodeRecord,
  decodeSpaceRow,
  parseJson,
  requireRevision,
  SPACE_COLUMNS,
  stringifyJson,
  validateCanvasFile,
  validateNodeContent,
} from '../sql/codecs.js';
