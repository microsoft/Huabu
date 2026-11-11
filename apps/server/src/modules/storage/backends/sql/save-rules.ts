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

import {
  numberColumn,
  parseJson,
  rowObject,
  stringColumn,
  stringifyJson,
} from './codecs.js';
import {
  advanceStamps,
  normalizeSaveKey,
  parseNodeStamps,
  SAVE_RESULT_PRUNE_LIMIT,
  SAVE_RESULT_RETENTION_MS,
  validateSaveResult,
} from '../../ports/save.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  NodeStamp,
  SaveKey,
  SaveResult,
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

/** Parameters of {@link SELECT_SAVE_RESULT}. */
export function saveResultKeyParams(
  workspaceId: string,
  canvasId: string,
  key: SaveKey,
): [string, string, string, string] {
  const normalized = normalizeSaveKey(key);
  return [
    workspaceId,
    canvasId,
    normalized.principalId,
    normalized.operationId,
  ];
}

/** Parameters of {@link PRUNE_SAVE_RESULTS}: results past retention, bounded. */
export function pruneSaveResultsParams(
  canvasId: string,
  now: number,
): [string, string, number, number] {
  return [
    canvasId,
    canvasId,
    now - SAVE_RESULT_RETENTION_MS,
    SAVE_RESULT_PRUNE_LIMIT,
  ];
}

/** Parameters of both result-row inserts. */
export function insertSaveResultParams(
  canvasId: string,
  result: SaveResult,
  responseJson: string,
  atVersion: number,
  now: number,
): [string, string, string, string, number, number, string] {
  const key = normalizeSaveKey(result.key);
  return [
    canvasId,
    key.principalId,
    key.operationId,
    result.digest,
    atVersion,
    now,
    responseJson,
  ];
}

/** Parameters of {@link INSERT_SAVE_HEAD} for a baseline at `version`. */
export function newSaveHeadParams(
  canvasId: string,
  lineage: string,
  version: number,
): [string, string, number, string] {
  return [canvasId, lineage, version, '{}'];
}

/**
 * The stamp update one record replacement needs, as parameters of
 * {@link UPDATE_SAVE_STAMPS}; null when the Space has no baseline
 * (`headRow` undefined) or the replacement moved no stamp.
 */
export function advanceSaveStampsParams(
  headRow: unknown,
  canvasId: string,
  current: CanvasFile,
  next: CanvasFile,
): [string, string] | null {
  if (headRow === undefined) return null;
  const head = decodeSaveHeadRow(headRow);
  const advanced = advanceStamps(
    stampsOf(head, current.version),
    current.state.nodes,
    next.state.nodes,
    next.version,
  );
  if (advanced.nodes === head.nodes) return null;
  return [stringifyJson(advanced.nodes, `Space ${canvasId} stamps`), canvasId];
}

/** Validate a `save.record` call; returns the encoded response. */
export function validateSaveRecordInput(input: {
  expectedVersion: number;
  result: SaveResult;
}): string {
  if (!Number.isFinite(input.expectedVersion)) {
    throw new TypeError('expectedVersion must be a finite number');
  }
  return validateSaveResult(input.result);
}

/**
 * Whether `save.record` may store its result against the Space as read
 * inside the transaction: null to proceed, the refusal otherwise.
 */
export function checkSaveRecordVersion(
  canvasId: string,
  state: { version: number } | null,
  expectedVersion: number,
): { ok: false; reason: 'version-conflict'; actualVersion: number } | null {
  if (state === null) {
    throw new Error(
      `SpaceSave(${canvasId}) cannot record a result for a missing Space`,
    );
  }
  if (state.version === expectedVersion) return null;
  return {
    ok: false,
    reason: 'version-conflict',
    actualVersion: state.version,
  };
}

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
