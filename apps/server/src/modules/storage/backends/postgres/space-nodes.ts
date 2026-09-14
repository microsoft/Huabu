// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { decodeNodeRecord, spaceRowExists, stringifyJson } from './rows.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { allocateNodeIdentity } from '../sql/identity.js';
import {
  collectNodeRow,
  decodeIdentifiedNodeRow,
  decodeNodeRow,
  validatePut,
} from '../sql/node-rules.js';

import type { PgExecutor, PostgresStoreContext } from './database.js';
import type {
  NodeDeleteResult,
  NodePutInput,
  NodePutResult,
  NodeSnapshot,
  NodeStreamOptions,
  SpaceNodes,
} from '../../ports/structured.js';
import type { NodeRow } from '../sql/node-rules.js';

async function readNodeRow(
  database: PgExecutor,
  canvasId: string,
  nodeId: string,
): Promise<NodeRow | null> {
  const row = await database.get(
    `SELECT record_json, revision, label_collision_key
       FROM nodes
       WHERE canvas_id = ? AND node_id = ?`,
    canvasId,
    nodeId,
  );
  return row === undefined ? null : decodeNodeRow(row, nodeId);
}

/**
 * Ids per `readMany` statement.
 *
 * Comfortably under a bounded parameter budget with room for the
 * `canvas_id` bind, so a caller never has to know the limit exists.
 */
const READ_MANY_CHUNK = 500;

/** Apply one node put inside the caller's active transaction. */
export async function putPostgresNodeInTransaction(
  database: PgExecutor,
  workspaceId: string,
  canvasId: string,
  input: NodePutInput,
): Promise<NodePutResult> {
  const nodeId = validatePut(input);
  if (!(await spaceRowExists(database, workspaceId, canvasId))) {
    return { ok: false, reason: 'not-found' };
  }

  const current = await readNodeRow(database, canvasId, nodeId);
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

  const occupied = (
    await database.all(
      `SELECT label_collision_key
       FROM nodes
       WHERE canvas_id = ? AND node_id <> ?`,
      canvasId,
      nodeId,
    )
  )
    .map((row) => row['label_collision_key'])
    .filter((value): value is string => typeof value === 'string');
  const allocation = allocateNodeIdentity(
    input.record,
    nodeId,
    current?.collisionKey ?? null,
    input.strictLabel === true ? [] : occupied,
  );

  if (input.strictLabel === true) {
    const conflict = await database.get(
      `SELECT node_id, record_json, label_collision_key
         FROM nodes
         WHERE canvas_id = ?
           AND label_collision_key = ?
           AND node_id <> ?`,
      canvasId,
      allocation.desiredCollisionKey,
      nodeId,
    );
    if (conflict !== undefined) {
      const conflictingNodeId = conflict['node_id'];
      const collisionKey = conflict['label_collision_key'];
      if (typeof conflictingNodeId !== 'string') {
        throw new SyntaxError('Invalid conflicting Postgres Node id');
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
  await database.run(
    `INSERT INTO nodes (
         canvas_id, node_id, record_json, revision, label_collision_key
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(canvas_id, node_id) DO UPDATE SET
         record_json = excluded.record_json,
         revision = excluded.revision,
         label_collision_key = excluded.label_collision_key`,
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

export class PostgresSpaceNodes implements SpaceNodes {
  readonly canvasId: string;

  readonly #context: PostgresStoreContext;
  readonly #workspaceId: string;

  constructor(
    context: PostgresStoreContext,
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
      `Postgres Space nodes(${this.canvasId})`,
    );
  }

  async read(nodeIdInput: string): Promise<NodeSnapshot | null> {
    const nodeId = sanitizeId(nodeIdInput, 'nodeId');
    this.#workspace();
    if (
      !(await spaceRowExists(
        this.#context.database(),
        this.#workspaceId,
        this.canvasId,
      ))
    )
      return null;
    const current = await readNodeRow(
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
    if (
      wanted.length === 0 ||
      !(await spaceRowExists(database, this.#workspaceId, this.canvasId))
    )
      return snapshots;

    // One statement per batch rather than one per id: a neighbourhood read
    // asks for tens of nodes, and the port exists so that cost stays
    // proportional to the request, with a bounded parameter budget.
    for (let start = 0; start < wanted.length; start += READ_MANY_CHUNK) {
      const chunk = wanted.slice(start, start + READ_MANY_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await database.all(
        `SELECT node_id, record_json, revision, label_collision_key
           FROM nodes
           WHERE canvas_id = ? AND node_id IN (${placeholders})`,
        this.canvasId,
        ...chunk,
      );
      for (const value of rows) collectNodeRow(value, snapshots);
    }
    return snapshots;
  }

  async list(): Promise<Map<string, NodeSnapshot>> {
    const snapshots = new Map<string, NodeSnapshot>();
    for (const value of await this.#scan()) collectNodeRow(value, snapshots);
    return snapshots;
  }

  async stream(
    onNode: (snapshot: NodeSnapshot) => void,
    options?: NodeStreamOptions,
  ): Promise<Map<string, NodeSnapshot>> {
    const delivered = new Map<string, NodeSnapshot>();
    this.#workspace();
    if (options?.signal?.aborted) return delivered;
    if (
      !(await spaceRowExists(
        this.#context.database(),
        this.#workspaceId,
        this.canvasId,
      ))
    )
      return delivered;
    let after: string | null = null;
    // Keyset batches deliver the first rows before reading the rest. Abort
    // stops fetching, with at most one bounded batch already in memory.
    while (!options?.signal?.aborted) {
      const rows = await this.#context.database().all(
        `SELECT node_id, record_json, revision, label_collision_key FROM nodes
         WHERE canvas_id = ? AND (?::text IS NULL OR node_id > ?)
         ORDER BY node_id LIMIT 128`,
        this.canvasId,
        after,
        after,
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (options?.signal?.aborted) return delivered;
        const [nodeId, snapshot] = decodeIdentifiedNodeRow(row);
        onNode(snapshot);
        delivered.set(nodeId, snapshot);
        after = nodeId;
      }
    }
    return delivered;
  }

  async #scan(): Promise<unknown[]> {
    this.#workspace();
    if (
      !(await spaceRowExists(
        this.#context.database(),
        this.#workspaceId,
        this.canvasId,
      ))
    )
      return [];
    return await this.#context.database().all(
      `SELECT node_id, record_json, revision, label_collision_key
         FROM nodes
         WHERE canvas_id = ?`,
      this.canvasId,
    );
  }

  async put(input: NodePutInput): Promise<NodePutResult> {
    validatePut(input);
    const workspaceId = this.#workspace();
    this.#context.assertMutationAllowed(this.canvasId);
    return await this.#context.transaction(
      async (database) =>
        await putPostgresNodeInTransaction(
          database,
          workspaceId,
          this.canvasId,
          input,
        ),
    );
  }

  async delete(nodeIdInput: string): Promise<NodeDeleteResult> {
    const nodeId = sanitizeId(nodeIdInput, 'nodeId');
    const workspaceId = this.#workspace();
    this.#context.assertMutationAllowed(this.canvasId);
    return await this.#context.transaction(async (database) => {
      if (!(await spaceRowExists(database, workspaceId, this.canvasId))) {
        return 'absent' as const;
      }
      const deleted = Number(
        (
          await database.run(
            'DELETE FROM nodes WHERE canvas_id = ? AND node_id = ?',
            this.canvasId,
            nodeId,
          )
        ).changes,
      );
      return deleted === 1 ? ('deleted' as const) : ('absent' as const);
    });
  }
}
