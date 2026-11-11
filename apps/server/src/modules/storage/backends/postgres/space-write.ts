// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  insertSpaceRow,
  occupiedCollisionKeys,
  readSpaceRow,
  updateSpaceRow,
} from './rows.js';
import { putPostgresNodeInTransaction } from './space-nodes.js';
import {
  advancePostgresStamps,
  insertPostgresSaveResult,
  PostgresSaveResultRaceError,
  readPostgresSaveResult,
  resolvePostgresSaveResultRace,
} from './space-save.js';
import {
  storedResultOutcome,
  validateWriteSaveResult,
} from '../../ports/save.js';
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

    try {
      return await context.transaction((database) =>
        writePostgresSpaceInTransaction(
          database,
          workspaceId,
          canvasId,
          input,
          context.now,
        ),
      );
    } catch (error) {
      if (
        !(error instanceof PostgresSaveResultRaceError) ||
        input.result === undefined
      ) {
        throw error;
      }
      // The transaction rolled back, so none of this write's state landed.
      return resolvePostgresSaveResultRace(
        context,
        workspaceId,
        canvasId,
        input.result,
        error,
      );
    }
  };
}

/**
 * Adapter-internal: the caller owns the transaction and writer admission.
 *
 * A result record and the Space's version stamps are part of the same
 * transaction: the stored result is checked before anything is touched, and
 * the stamps and the new result row are written after the record, so all of
 * it commits or none of it does.
 */
export async function writePostgresSpaceInTransaction(
  database: PgExecutor,
  workspaceId: string,
  canvasId: string,
  input: SpaceWriteInput,
  now: () => number = Date.now,
): Promise<SpaceWriteResult> {
  validateInput(canvasId, input);
  const responseJson = validateWriteSaveResult(input);
  if (input.result !== undefined) {
    // First, before the version check: a retry of a committed write arrives
    // with a stale expected version and must be answered, not refused.
    const stored = await readPostgresSaveResult(
      database,
      workspaceId,
      canvasId,
      input.result.key,
    );
    if (stored) return storedResultOutcome(stored, input.result);
  }
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
  await advancePostgresStamps(
    database,
    canvasId,
    current.record,
    input.nextRecord,
  );
  if (input.result !== undefined && responseJson !== null) {
    await insertPostgresSaveResult(
      database,
      canvasId,
      input.result,
      responseJson,
      input.nextRecord.version,
      now(),
    );
  }
  return { ok: true } as const;
}
