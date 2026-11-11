// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * PostgreSQL result records and version stamps.
 *
 * The twin of `sqlite/space-save.ts`: the same tables, the same SQL text, the
 * same rules, executed through the asynchronous adapter. The in-transaction
 * helpers are what {@link writePostgresSpaceInTransaction} calls so a result
 * record and the advanced stamps commit with the state they describe.
 */

import { randomUUID } from 'node:crypto';

import { normalizeSaveKey, storedResultOutcome } from '../../ports/save.js';
import {
  advanceSaveStampsParams,
  checkSaveRecordVersion,
  decodeSaveResultRow,
  decodeSpaceSaveState,
  INSERT_SAVE_HEAD,
  INSERT_SAVE_RESULT_IF_ABSENT,
  insertSaveResultParams,
  newSaveHeadParams,
  PRUNE_SAVE_RESULTS,
  pruneSaveResultsParams,
  saveResultKeyParams,
  SELECT_SAVE_HEAD,
  SELECT_SAVE_RESULT,
  SELECT_SPACE_SAVE_STATE,
  stampsOf,
  UPDATE_SAVE_STAMPS,
  validateSaveRecordInput,
} from '../sql/save-rules.js';

import type { PgExecutor, PostgresStoreContext } from './database.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SaveKey,
  SaveResult,
  SpaceSave,
  StoredSaveResult,
} from '../../ports/save.js';

/**
 * The key was stored by someone else between this transaction's check and its
 * insert.
 *
 * The adapter serializes its transactions, so this is not expected; it exists
 * so that a second writer this process does not know about produces the
 * documented `result-exists` answer rather than a duplicate or a constraint
 * error. Thrown to roll the transaction back — the state it wrote must not
 * commit beside another request's result.
 */
export class PostgresSaveResultRaceError extends Error {
  override name = 'PostgresSaveResultRaceError';
}

export async function readPostgresSaveResult(
  database: PgExecutor,
  workspaceId: string,
  canvasId: string,
  key: SaveKey,
): Promise<StoredSaveResult | null> {
  const row = await database.get(
    SELECT_SAVE_RESULT,
    ...saveResultKeyParams(workspaceId, canvasId, key),
  );
  return row === undefined ? null : decodeSaveResultRow(row);
}

/**
 * Store one result record and prune a bounded number of expired ones.
 *
 * Inside the caller's transaction, after the key was found absent.
 */
export async function insertPostgresSaveResult(
  database: PgExecutor,
  canvasId: string,
  result: SaveResult,
  responseJson: string,
  atVersion: number,
  now: number,
): Promise<void> {
  await database.run(
    PRUNE_SAVE_RESULTS,
    ...pruneSaveResultsParams(canvasId, now),
  );
  const inserted = await database.run(
    INSERT_SAVE_RESULT_IF_ABSENT,
    ...insertSaveResultParams(canvasId, result, responseJson, atVersion, now),
  );
  if (inserted.changes !== 1) {
    throw new PostgresSaveResultRaceError(
      `Result record for ${JSON.stringify(normalizeSaveKey(result.key).operationId)} appeared concurrently`,
    );
  }
}

/**
 * Advance the Space's stamps across one record replacement.
 *
 * One indexed lookup when the Space has no baseline — the whole cost of this
 * feature for a Space that never asked for stamps.
 */
export async function advancePostgresStamps(
  database: PgExecutor,
  canvasId: string,
  current: CanvasFile,
  next: CanvasFile,
): Promise<void> {
  const update = advanceSaveStampsParams(
    await database.get(SELECT_SAVE_HEAD, canvasId),
    canvasId,
    current,
    next,
  );
  if (update) await database.run(UPDATE_SAVE_STAMPS, ...update);
}

/** Bind the `save` member of one PostgreSQL Space handle. */
export function createPostgresSpaceSave(
  context: PostgresStoreContext,
  boundWorkspaceId: string,
  canvasId: string,
): SpaceSave {
  const workspace = (): string =>
    context.assertBoundWorkspace(boundWorkspaceId, `SpaceSave(${canvasId})`);
  const readState = async (database: PgExecutor, workspaceId: string) =>
    decodeSpaceSaveState(
      await database.get(SELECT_SPACE_SAVE_STATE, workspaceId, canvasId),
    );

  return Object.freeze({
    async lookup(key: SaveKey): Promise<StoredSaveResult | null> {
      const workspaceId = workspace();
      return readPostgresSaveResult(
        context.database(),
        workspaceId,
        canvasId,
        key,
      );
    },

    async stamps() {
      const workspaceId = workspace();
      const observed = await readState(context.database(), workspaceId);
      if (observed === null) return null;
      if (observed.head) return stampsOf(observed.head, observed.version);

      // Creating the baseline is a mutation, so it honours the deletion fence
      // like every other one; reading an existing baseline above does not.
      context.assertMutationAllowed(canvasId);
      return context.transaction(async (database) => {
        const current = await readState(database, workspaceId);
        if (current === null) return null;
        if (!current.head) {
          await database.run(
            INSERT_SAVE_HEAD,
            ...newSaveHeadParams(canvasId, randomUUID(), current.version),
          );
        }
        const settled = await readState(database, workspaceId);
        if (!settled?.head) {
          throw new Error(`Could not create the save baseline of ${canvasId}`);
        }
        return stampsOf(settled.head, settled.version);
      });
    },

    async record(input: { expectedVersion: number; result: SaveResult }) {
      const workspaceId = workspace();
      context.assertMutationAllowed(canvasId);
      const responseJson = validateSaveRecordInput(input);
      try {
        return await context.transaction(async (database) => {
          const stored = await readPostgresSaveResult(
            database,
            workspaceId,
            canvasId,
            input.result.key,
          );
          if (stored) return storedResultOutcome(stored, input.result);
          const state = await readState(database, workspaceId);
          const conflict = checkSaveRecordVersion(
            canvasId,
            state,
            input.expectedVersion,
          );
          if (conflict) return conflict;
          await insertPostgresSaveResult(
            database,
            canvasId,
            input.result,
            responseJson,
            input.expectedVersion,
            context.now(),
          );
          return { ok: true } as const;
        });
      } catch (error) {
        if (!(error instanceof PostgresSaveResultRaceError)) throw error;
        return resolvePostgresSaveResultRace(
          context,
          workspaceId,
          canvasId,
          input.result,
          error,
        );
      }
    },
  });
}

/** After a rolled-back race: answer from whatever the other writer stored. */
export async function resolvePostgresSaveResultRace(
  context: PostgresStoreContext,
  workspaceId: string,
  canvasId: string,
  result: SaveResult,
  race: PostgresSaveResultRaceError,
): Promise<{ ok: false; reason: 'result-exists'; stored: StoredSaveResult }> {
  const stored = await readPostgresSaveResult(
    context.database(),
    workspaceId,
    canvasId,
    result.key,
  );
  if (!stored) throw race;
  return storedResultOutcome(stored, result);
}
