// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SQL text and row codecs for result records and version stamps.
 *
 * Shared by the SQLite and PostgreSQL adapters: both keep the same two tables
 * (migration v5) and differ only in how a statement is executed. Parameters
 * are positional `?`; no statement here contains a literal `?`.
 *
 * Neither table carries a Workspace column. Like `nodes` and `delta_log` they
 * hang off `spaces(canvas_id)` — unique across the database — with
 * `ON DELETE CASCADE`, so they follow a Space through rename and re-parenting
 * (neither changes `canvas_id`) and go when it is deleted. Reads that start
 * from a handle still join `spaces` on `workspace_id`, so a handle resolved in
 * one Workspace cannot answer for a Space in another.
 */

import { numberColumn, parseJson, rowObject, stringColumn } from './codecs.js';
import { parseNodeStamps } from '../../ports/save.js';

import type {
  NodeStamp,
  SpaceStamps,
  StoredSaveResult,
} from '../../ports/save.js';

export const SELECT_SAVE_RESULT = `
  SELECT r.digest AS digest, r.at_version AS at_version,
         r.response_json AS response_json
  FROM space_save_results r
  JOIN spaces s ON s.canvas_id = r.canvas_id
  WHERE s.workspace_id = ? AND r.canvas_id = ?
    AND r.principal_id = ? AND r.operation_id = ?`;

const INSERT_SAVE_RESULT_COLUMNS = `
  INSERT INTO space_save_results (
    canvas_id, principal_id, operation_id, digest, at_version, created_at,
    response_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`;

export const INSERT_SAVE_RESULT = INSERT_SAVE_RESULT_COLUMNS;

/** Reports `changes = 0` instead of raising when the key is already stored. */
export const INSERT_SAVE_RESULT_IF_ABSENT = `${INSERT_SAVE_RESULT_COLUMNS}
  ON CONFLICT (canvas_id, principal_id, operation_id) DO NOTHING`;

/** Parameters: canvas id, canvas id, cutoff timestamp, row limit. */
export const PRUNE_SAVE_RESULTS = `
  DELETE FROM space_save_results
  WHERE canvas_id = ? AND (principal_id, operation_id) IN (
    SELECT principal_id, operation_id
    FROM space_save_results
    WHERE canvas_id = ? AND created_at < ?
    ORDER BY created_at
    LIMIT ?
  )`;

/** The head row alone; the caller has already scoped the Space. */
export const SELECT_SAVE_HEAD = `
  SELECT lineage, floor, stamps_json
  FROM space_save_heads
  WHERE canvas_id = ?`;

/** One statement, so the version and the head are read together. */
export const SELECT_SPACE_SAVE_STATE = `
  SELECT s.version AS version, h.lineage AS lineage, h.floor AS floor,
         h.stamps_json AS stamps_json
  FROM spaces s
  LEFT JOIN space_save_heads h ON h.canvas_id = s.canvas_id
  WHERE s.workspace_id = ? AND s.canvas_id = ?`;

export const INSERT_SAVE_HEAD = `
  INSERT INTO space_save_heads (canvas_id, lineage, floor, stamps_json)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (canvas_id) DO NOTHING`;

export const UPDATE_SAVE_STAMPS = `
  UPDATE space_save_heads SET stamps_json = ? WHERE canvas_id = ?`;

export function decodeSaveResultRow(value: unknown): StoredSaveResult {
  const row = rowObject(value, 'save result row');
  return {
    digest: stringColumn(row, 'digest', 'save result row'),
    atVersion: numberColumn(row, 'at_version', 'save result row'),
    response: parseJson(row['response_json'], 'save result response'),
  };
}

export interface PersistedSaveHead {
  readonly lineage: string;
  readonly floor: number;
  readonly nodes: Record<string, NodeStamp>;
}

export function decodeSaveHeadRow(value: unknown): PersistedSaveHead {
  const row = rowObject(value, 'save head row');
  return {
    lineage: stringColumn(row, 'lineage', 'save head row'),
    floor: numberColumn(row, 'floor', 'save head row'),
    nodes: parseNodeStamps(
      parseJson(row['stamps_json'], 'save head stamps'),
      'save head stamps',
    ),
  };
}

/**
 * Decode {@link SELECT_SPACE_SAVE_STATE}.
 *
 * `undefined` row → the Space is absent. A row without a head → the Space
 * exists and has no baseline yet (`head: null`).
 */
export function decodeSpaceSaveState(
  value: unknown,
): { version: number; head: PersistedSaveHead | null } | null {
  if (value === undefined) return null;
  const row = rowObject(value, 'space save state row');
  const version = numberColumn(row, 'version', 'space save state row');
  if (row['lineage'] === null || row['lineage'] === undefined) {
    return { version, head: null };
  }
  return { version, head: decodeSaveHeadRow(row) };
}

export function stampsOf(
  head: PersistedSaveHead,
  version: number,
): SpaceStamps {
  return {
    lineage: head.lineage,
    floor: head.floor,
    version,
    nodes: head.nodes,
  };
}
