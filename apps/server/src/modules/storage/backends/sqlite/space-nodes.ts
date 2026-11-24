// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { withImmediateTransaction } from './database.js';
import { spaceRowExists } from './rows.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { stringifyJson } from '../sql/codecs.js';
import { allocateNodeIdentity } from '../sql/identity.js';
import {
  absentNodeChangePosition,
  collectNodeRow,
  decodeChangeSeq,
  decodeIdentifiedNodeRow,
  decodeLabelConflict,
  decodeNodeRow,
  isComparableNodeChangePosition,
  nodeChangeEpoch,
  validatePut,
} from '../sql/node-rules.js';

import type { SqliteStoreContext } from './database.js';
import type {
  NodeChangePosition,
  NodeChanges,
  NodeDeleteResult,
  NodePutInput,
  NodePutResult,
  NodeSnapshot,
  NodeStreamOptions,
  SpaceNodes,
} from '../../ports/structured.js';
import type { NodeRow } from '../sql/node-rules.js';
import type { DatabaseSync } from 'node:sqlite';

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

/**
 * Ids per `readMany` statement.
 *
 * Comfortably under SQLite's default 999-parameter ceiling with room for the
 * `canvas_id` bind, so a caller never has to know the limit exists.
 */
const READ_MANY_CHUNK = 500;

/** Apply one node put inside the caller's active transaction. */
export function putSqliteNodeInTransaction(
  database: DatabaseSync,
  workspaceId: string,
  canvasId: string,
  input: NodePutInput,
): NodePutResult {
  const nodeId = validatePut(input);
  if (!spaceRowExists(database, workspaceId, canvasId)) {
    return { ok: false, reason: 'not-found' };
  }

  const current = readNodeRow(database, canvasId, nodeId);
  const currentRevision = current?.revision ?? null;
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
      return decodeLabelConflict(conflict);
    }
  }

  const revision = randomUUID();
  // The Space's counter of node writes, advanced in this transaction, so the
  // order of the values is the order the writes became visible in.
  const changeSeq = database
    .prepare(
      `UPDATE spaces SET node_change_seq = node_change_seq + 1
       WHERE workspace_id = ? AND canvas_id = ?
       RETURNING node_change_seq`,
    )
    .get(workspaceId, canvasId)?.['node_change_seq'];
  database
    .prepare(
      `INSERT INTO nodes (
         canvas_id, node_id, record_json, revision, label_collision_key,
         change_seq
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(canvas_id, node_id) DO UPDATE SET
         record_json = excluded.record_json,
         revision = excluded.revision,
         label_collision_key = excluded.label_collision_key,
         change_seq = excluded.change_seq`,
    )
    .run(
      canvasId,
      nodeId,
      stringifyJson(allocation.record, `Node ${JSON.stringify(nodeId)} record`),
      revision,
      allocation.collisionKey,
      decodeChangeSeq(changeSeq),
    );
  return {
    ok: true,
    record: allocation.record,
    revision,
  };
}

export class SqliteSpaceNodes implements SpaceNodes {
  readonly canvasId: string;

  readonly #context: SqliteStoreContext;
  readonly #workspaceId: string;

  constructor(
    context: SqliteStoreContext,
    workspaceId: string,
    canvasId: string,
  ) {
    this.#context = context;
    this.#workspaceId = workspaceId;
    this.canvasId = canvasId;
  }

  #workspace(): string {
    return this.#context.assertBoundWorkspace(
      this.#workspaceId,
      `SQLite Space nodes(${this.canvasId})`,
    );
  }

  async read(nodeIdInput: string): Promise<NodeSnapshot | null> {
    const nodeId = sanitizeId(nodeIdInput, 'nodeId');
    this.#workspace();
    const current = readNodeRow(
      this.#context.database(),
      this.canvasId,
      nodeId,
    );
    return current === null
      ? null
      : { record: current.record, revision: current.revision };
  }

  async readMany(
    nodeIds: readonly string[],
  ): Promise<Map<string, NodeSnapshot>> {
    const wanted = [...new Set(nodeIds)].map((nodeId) =>
      sanitizeId(nodeId, 'nodeId'),
    );
    // Before the empty-batch shortcut: asking a closed store for nothing is
    // still asking a closed store.
    this.#workspace();
    const database = this.#context.database();
    const snapshots = new Map<string, NodeSnapshot>();
    if (wanted.length === 0) return snapshots;

    // One statement per batch rather than one per id: a neighbourhood read
    // asks for tens of nodes, and the port exists so that cost stays
    // proportional to the request. SQLite caps a statement at
    // SQLITE_MAX_VARIABLE_NUMBER parameters, so the batch is chunked rather
    // than assumed to fit.
    for (let start = 0; start < wanted.length; start += READ_MANY_CHUNK) {
      const chunk = wanted.slice(start, start + READ_MANY_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = database
        .prepare(
          `SELECT node_id, record_json, revision, label_collision_key
           FROM nodes
           WHERE canvas_id = ? AND node_id IN (${placeholders})`,
        )
        .all(this.canvasId, ...chunk);
      for (const value of rows) collectNodeRow(value, snapshots);
    }
    return snapshots;
  }

  async list(): Promise<Map<string, NodeSnapshot>> {
    const snapshots = new Map<string, NodeSnapshot>();
    for (const value of this.#scan()) collectNodeRow(value, snapshots);
    return snapshots;
  }

  async stream(
    onNode: (snapshot: NodeSnapshot) => void,
    options?: NodeStreamOptions,
  ): Promise<Map<string, NodeSnapshot>> {
    const delivered = new Map<string, NodeSnapshot>();
    // Decoded row by row off a live cursor, so a reader that renders partial
    // results sees the first node without waiting for the last, and an
    // aborted scan stops reading rather than discarding rows it already
    // materialized.
    for (const value of this.#scan()) {
      if (options?.signal?.aborted) break;
      const [nodeId, snapshot] = decodeIdentifiedNodeRow(value);
      onNode(snapshot);
      delivered.set(nodeId, snapshot);
    }
    return delivered;
  }

  #scan(): Iterable<unknown> {
    this.#workspace();
    return this.#context
      .database()
      .prepare(
        `SELECT node_id, record_json, revision, label_collision_key
         FROM nodes
         WHERE canvas_id = ?`,
      )
      .iterate(this.canvasId);
  }

  async changes(since?: NodeChangePosition): Promise<NodeChanges> {
    const workspaceId = this.#workspace();
    const database = this.#context.database();
    // Both statements run synchronously on the one connection, so no write
    // can land between the counter and the rows.
    const row = database
      .prepare(
        `SELECT node_change_seq, created_at
         FROM spaces
         WHERE workspace_id = ? AND canvas_id = ?`,
      )
      .get(workspaceId, this.canvasId);
    if (row === undefined)
      return { position: absentNodeChangePosition('sqlite'), nodeIds: null };
    const position = {
      epoch: nodeChangeEpoch('sqlite', row['created_at']),
      seq: decodeChangeSeq(row['node_change_seq']),
    };
    if (!isComparableNodeChangePosition(since, position))
      return { position, nodeIds: null };
    const nodeIds = database
      .prepare(
        `SELECT node_id FROM nodes
         WHERE canvas_id = ? AND change_seq > ?`,
      )
      .all(this.canvasId, since.seq)
      .map((entry) => String(entry['node_id']));
    return { position, nodeIds };
  }

  async put(input: NodePutInput): Promise<NodePutResult> {
    validatePut(input);
    const workspaceId = this.#workspace();
    this.#context.assertMutationAllowed(this.canvasId);
    const database = this.#context.database();
    return withImmediateTransaction(database, () =>
      putSqliteNodeInTransaction(database, workspaceId, this.canvasId, input),
    );
  }

  async delete(nodeIdInput: string): Promise<NodeDeleteResult> {
    const nodeId = sanitizeId(nodeIdInput, 'nodeId');
    const workspaceId = this.#workspace();
    this.#context.assertMutationAllowed(this.canvasId);
    const database = this.#context.database();
    return withImmediateTransaction(database, () => {
      if (!spaceRowExists(database, workspaceId, this.canvasId)) {
        return 'absent' as const;
      }
      const deleted = Number(
        database
          .prepare('DELETE FROM nodes WHERE canvas_id = ? AND node_id = ?')
          .run(this.canvasId, nodeId).changes,
      );
      return deleted === 1 ? ('deleted' as const) : ('absent' as const);
    });
  }
}
