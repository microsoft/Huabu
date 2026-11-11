// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { withImmediateTransaction } from './database.js';
import {
  insertSpaceRow,
  occupiedCollisionKeys,
  readSpaceRow,
  updateSpaceRow,
} from './rows.js';
import { putSqliteNodeInTransaction } from './space-nodes.js';
import { stringifyJson } from '../sql/codecs.js';
import { allocateSpaceIdentity } from '../sql/identity.js';
import {
  checkWritePreconditions,
  mutationError,
  validateInput,
} from '../sql/write-rules.js';

import type { SqliteStoreContext } from './database.js';
import type {
  SpaceHandle,
  SpaceWriteInput,
  SpaceWriteResult,
} from '../../ports/structured.js';
import type { DatabaseSync } from 'node:sqlite';

/** Bind the atomic SQLite record/node/delta write to one Space. */
export function createSqliteSpaceWrite(
  context: SqliteStoreContext,
  boundWorkspaceId: string,
  canvasId: string,
): SpaceHandle['write'] {
  return async function write(
    input: SpaceWriteInput,
  ): Promise<SpaceWriteResult> {
    const workspaceId = context.assertBoundWorkspace(
      boundWorkspaceId,
      `SpaceWrite(${canvasId})`,
    );
    context.assertMutationAllowed(canvasId);
    validateInput(canvasId, input);
    const database = context.database();

    return withImmediateTransaction(database, () =>
      writeSqliteSpaceInTransaction(database, workspaceId, canvasId, input),
    );
  };
}

/** Reuse the ordered writer inside the operation's larger receipt transaction. */
export function writeSqliteSpaceInTransaction(
  database: DatabaseSync,
  workspaceId: string,
  canvasId: string,
  input: SpaceWriteInput,
): SpaceWriteResult {
  if (!database.isTransaction)
    throw new Error('Space write requires a transaction');
  validateInput(canvasId, input);
  const current = readSpaceRow(database, workspaceId, canvasId);
  const rejected = checkWritePreconditions(
    canvasId,
    current?.record ?? null,
    input,
  );
  if (rejected) return rejected;
  if (current === null) {
    const identity = allocateSpaceIdentity(
      input.nextRecord.title,
      canvasId,
      occupiedCollisionKeys(database, workspaceId),
    );
    insertSpaceRow(
      database,
      workspaceId,
      { ...input.nextRecord, title: identity.title },
      identity.collisionKey,
    );
    return { ok: true } as const;
  }

  for (const mutation of input.nodeMutations) {
    if (mutation.kind === 'delete') {
      database
        .prepare('DELETE FROM nodes WHERE canvas_id = ? AND node_id = ?')
        .run(canvasId, mutation.nodeId);
      continue;
    }

    const result = putSqliteNodeInTransaction(database, workspaceId, canvasId, {
      nodeId: mutation.nodeId,
      record: mutation.record,
      strictLabel: mutation.strictLabel,
    });
    if (!result.ok) throw mutationError(mutation, result);
  }

  if (
    updateSpaceRow(
      database,
      workspaceId,
      input.nextRecord,
      input.expectedVersion,
    ) !== 1
  ) {
    throw new Error(`SpaceWrite(${canvasId}) lost its version race`);
  }
  if (input.delta !== undefined) {
    database
      .prepare(
        `INSERT INTO delta_log (canvas_id, version, entry_json)
             VALUES (?, ?, ?)`,
      )
      .run(
        canvasId,
        input.delta.version,
        stringifyJson(input.delta, `Space ${canvasId} delta`),
      );
  }
  return { ok: true } as const;
}
