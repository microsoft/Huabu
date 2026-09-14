// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { withImmediateTransaction } from './database.js';
import { allocateNodeIdentity } from './identity.js';
import {
  decodeNodeRecord,
  requireRevision,
  spaceRowExists,
  stringifyJson,
  validateNodeContent,
} from './rows.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type { SqliteStoreContext } from './database.js';
import type {
  NodeDeleteResult,
  NodePutInput,
  NodePutResult,
  NodeSnapshot,
  NodeStreamOptions,
  SpaceNodes,
} from '../../ports/structured.js';
import type { DatabaseSync } from 'node:sqlite';

interface NodeRow {
  readonly record: NodeSnapshot['record'];
  readonly revision: string;
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
    revision: requireRevision(row['revision'], nodeId),
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

/**
 * Ids per `readMany` statement.
 *
 * Comfortably under SQLite's default 999-parameter ceiling with room for the
 * `canvas_id` bind, so a caller never has to know the limit exists.
 */
const READ_MANY_CHUNK = 500;

/** Decode one scanned row into the id the port keys collections by. */
function decodeIdentifiedNodeRow(value: unknown): [string, NodeSnapshot] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SyntaxError('Malformed persisted SQLite Node row');
  }
  const nodeId = (value as Record<string, unknown>)['node_id'];
  if (typeof nodeId !== 'string') {
    throw new SyntaxError('Invalid node_id in persisted SQLite Node');
  }
  const row = decodeNodeRow(value, nodeId);
  return [nodeId, { record: row.record, revision: row.revision }];
}

function collectNodeRow(value: unknown, into: Map<string, NodeSnapshot>): void {
  const [nodeId, snapshot] = decodeIdentifiedNodeRow(value);
  into.set(nodeId, snapshot);
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

  const revision = randomUUID();
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
