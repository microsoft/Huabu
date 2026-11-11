// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  insertSpaceRow,
  occupiedCollisionKeys,
  readSpaceRow,
  updateSpaceRow,
} from './rows.js';
import { putPostgresNodeInTransaction } from './space-nodes.js';
import { stringifyJson } from '../sql/codecs.js';
import { allocateSpaceIdentity } from '../sql/identity.js';
import {
  checkWritePreconditions,
  mutationError,
  validateInput,
} from '../sql/write-rules.js';

import type { PgExecutor, PostgresStoreContext } from './database.js';
import type {
  SpaceHandle,
  SpaceWriteInput,
  SpaceWriteResult,
} from '../../ports/structured.js';

/** Bind the atomic Postgres record/node/delta write to one Space. */
export function createPostgresSpaceWrite(
  context: PostgresStoreContext,
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

    return context.transaction((database) =>
      writePostgresSpaceInTransaction(database, workspaceId, canvasId, input),
    );
  };
}

/** Adapter-internal: the caller owns the transaction and writer admission. */
export async function writePostgresSpaceInTransaction(
  database: PgExecutor,
  workspaceId: string,
  canvasId: string,
  input: SpaceWriteInput,
): Promise<SpaceWriteResult> {
  validateInput(canvasId, input);
  const current = await readSpaceRow(database, workspaceId, canvasId);
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
      await occupiedCollisionKeys(database, workspaceId),
    );
    await insertSpaceRow(
      database,
      workspaceId,
      { ...input.nextRecord, title: identity.title },
      identity.collisionKey,
    );
    return { ok: true } as const;
  }

  for (const mutation of input.nodeMutations) {
    if (mutation.kind === 'delete') {
      await database.run(
        'DELETE FROM nodes WHERE canvas_id = ? AND node_id = ?',
        canvasId,
        mutation.nodeId,
      );
      continue;
    }

    const result = await putPostgresNodeInTransaction(
      database,
      workspaceId,
      canvasId,
      {
        nodeId: mutation.nodeId,
        record: mutation.record,
        strictLabel: mutation.strictLabel,
      },
    );
    if (!result.ok) throw mutationError(mutation, result);
  }

  if (
    (await updateSpaceRow(
      database,
      workspaceId,
      input.nextRecord,
      input.expectedVersion,
    )) !== 1
  ) {
    throw new Error(`SpaceWrite(${canvasId}) lost its version race`);
  }
  if (input.delta !== undefined) {
    await database.run(
      `INSERT INTO delta_log (canvas_id, version, entry_json)
             VALUES (?, ?, ?)`,
      canvasId,
      input.delta.version,
      stringifyJson(input.delta, `Space ${canvasId} delta`),
    );
  }
  return { ok: true } as const;
}
