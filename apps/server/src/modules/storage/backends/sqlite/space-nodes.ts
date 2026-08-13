// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { withImmediateTransaction } from './database.js';
import {
  allocateNodeIdentity,
  decodeNodeRecord,
  requirePositiveRevision,
  stringifyJson,
  validateNodeContent,
} from './values.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type { SqliteStoreContext } from './database.js';
import type {
  NodeDeleteResult,
  NodePutInput,
  NodePutResult,
  NodeSnapshot,
  SpaceNodes,
} from '../../ports/structured.js';
import type { DatabaseSync } from 'node:sqlite';

interface NodeRow {
  readonly record: NodeSnapshot['record'];
  readonly revision: number;
  readonly collisionKey: string;
}

function decodeNodeRow(value: unknown, nodeId: string): NodeRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError(`Malformed persisted Node ${JSON.stringify(nodeId)}`);
  }
  const row = value as Record<string, unknown>;
  const collisionKey = row['label_collision_key'];
  if (typeof collisionKey !== 'string') {
    throw new SyntaxError(
      `Invalid collision key for Node ${JSON.stringify(nodeId)}`,
    );
  }
  return {
    record: decodeNodeRecord(row['record_json'], nodeId),
    revision: requirePositiveRevision(row['revision'], nodeId),
    collisionKey,
  };
}

function readNodeRow(
  database: DatabaseSync,
  canvasId: string,
  nodeId: string,
): NodeRow | null {
  const row = database
    .prepare(
      `SELECT record_json, revision, label_collision_key
       FROM nodes
       WHERE canvas_id = ? AND node_id = ?`,
    )
    .get(canvasId, nodeId);
  return row === undefined ? null : decodeNodeRow(row, nodeId);
}

function spaceExists(database: DatabaseSync, canvasId: string): boolean {
  return (
    database
      .prepare('SELECT 1 AS present FROM spaces WHERE canvas_id = ?')
      .get(canvasId)?.['present'] === 1
  );
}

function validatePut(input: NodePutInput): string {
  const nodeId = sanitizeId(input.nodeId, 'nodeId');
  validateNodeContent(input.record, nodeId);
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== null &&
    typeof input.expectedRevision !== 'string'
  ) {
    throw new TypeError('expectedRevision must be a string, null, or omitted');
  }
  return nodeId;
}

export interface SqliteNodePutOptions {
  readonly tombstoned: boolean;
  readonly bypassTombstone?: boolean;
}

/** Apply one node put inside the caller's active transaction. */
export function putSqliteNodeInTransaction(
  database: DatabaseSync,
  canvasId: string,
  input: NodePutInput,
  options: SqliteNodePutOptions,
): NodePutResult {
  const nodeId = validatePut(input);
  if (options.tombstoned && options.bypassTombstone !== true) {
    return { ok: false, reason: 'write-suppressed' };
  }
  if (!spaceExists(database, canvasId)) {
    return { ok: false, reason: 'not-found' };
  }

  const current = readNodeRow(database, canvasId, nodeId);
  const currentRevision = current === null ? null : String(current.revision);
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== currentRevision
  ) {
    return {
      ok: false,
      reason: 'revision-conflict',
      currentRevision,
    };
  }

  const occupied = database
    .prepare(
      `SELECT label_collision_key
       FROM nodes
       WHERE canvas_id = ? AND node_id <> ?`,
    )
    .all(canvasId, nodeId)
    .map((row) => row['label_collision_key'])
    .filter((value): value is string => typeof value === 'string');
  const allocation = allocateNodeIdentity(
    input.record,
    nodeId,
    current?.collisionKey ?? null,
    input.strictLabel === true ? [] : occupied,
  );

  if (input.strictLabel === true) {
    const conflict = database
      .prepare(
        `SELECT node_id, record_json, label_collision_key
         FROM nodes
         WHERE canvas_id = ?
           AND label_collision_key = ?
           AND node_id <> ?`,
      )
      .get(canvasId, allocation.desiredCollisionKey, nodeId);
    if (conflict !== undefined) {
      const conflictingNodeId = conflict['node_id'];
      const collisionKey = conflict['label_collision_key'];
      if (typeof conflictingNodeId !== 'string') {
        throw new SyntaxError('Invalid conflicting SQLite Node id');
      }
      const conflicting = decodeNodeRecord(
        conflict['record_json'],
        conflictingNodeId,
      );
      return {
        ok: false,
        reason: 'label-conflict',
        conflictingNodeId,
        conflictingLabel:
          typeof conflicting.label === 'string'
            ? conflicting.label
            : typeof collisionKey === 'string'
              ? collisionKey
              : conflictingNodeId,
      };
    }
  }

  const revision = (current?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new Error(`Node ${JSON.stringify(nodeId)} revision overflow`);
  }
  database
    .prepare(
      `INSERT INTO nodes (
         canvas_id, node_id, record_json, revision, label_collision_key
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(canvas_id, node_id) DO UPDATE SET
         record_json = excluded.record_json,
         revision = excluded.revision,
         label_collision_key = excluded.label_collision_key`,
    )
    .run(
      canvasId,
      nodeId,
      stringifyJson(allocation.record, `Node ${JSON.stringify(nodeId)} record`),
      revision,
      allocation.collisionKey,
    );
  return {
    ok: true,
    record: allocation.record,
    revision: String(revision),
  };
}

export class SqliteSpaceNodes implements SpaceNodes {
  readonly canvasId: string;

  readonly #context: SqliteStoreContext;

  constructor(context: SqliteStoreContext, canvasId: string) {
    this.#context = context;
    this.canvasId = canvasId;
  }

  async read(nodeIdInput: string): Promise<NodeSnapshot | null> {
    const nodeId = sanitizeId(nodeIdInput, 'nodeId');
    const current = readNodeRow(
      this.#context.database(),
      this.canvasId,
      nodeId,
    );
    return current === null
      ? null
      : { record: current.record, revision: String(current.revision) };
  }

  async put(input: NodePutInput): Promise<NodePutResult> {
    const nodeId = validatePut(input);
    this.#context.assertMutationAllowed(this.canvasId);
    if (this.#context.isNodeTombstoned(this.canvasId, nodeId)) {
      return { ok: false, reason: 'write-suppressed' };
    }
    const database = this.#context.database();
    return withImmediateTransaction(database, () =>
      putSqliteNodeInTransaction(database, this.canvasId, input, {
        tombstoned: false,
      }),
    );
  }

  async delete(nodeIdInput: string): Promise<NodeDeleteResult> {
    const nodeId = sanitizeId(nodeIdInput, 'nodeId');
    this.#context.assertMutationAllowed(this.canvasId);
    const database = this.#context.database();
    const result = withImmediateTransaction(database, () => {
      if (!spaceExists(database, this.canvasId))
        return 'missing-space' as const;
      const deleted = Number(
        database
          .prepare('DELETE FROM nodes WHERE canvas_id = ? AND node_id = ?')
          .run(this.canvasId, nodeId).changes,
      );
      return deleted === 1 ? ('deleted' as const) : ('absent' as const);
    });
    if (result === 'missing-space') return 'absent';
    if (result === 'deleted') {
      this.#context.setNodeTombstone(this.canvasId, nodeId, true);
    }
    return result;
  }
}
