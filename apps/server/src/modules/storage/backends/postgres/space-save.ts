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

import {
  advanceStamps,
  normalizeSaveKey,
  SAVE_RESULT_PRUNE_LIMIT,
  SAVE_RESULT_RETENTION_MS,
  storedResultOutcome,
  validateSaveResult,
} from '../../ports/save.js';
import { stringifyJson } from '../sql/codecs.js';
import {
  decodeSaveHeadRow,
  decodeSaveResultRow,
  decodeSpaceSaveState,
  INSERT_SAVE_HEAD,
  INSERT_SAVE_RESULT_IF_ABSENT,
  PRUNE_SAVE_RESULTS,
  SELECT_SAVE_HEAD,
  SELECT_SAVE_RESULT,
  SELECT_SPACE_SAVE_STATE,
  stampsOf,
  UPDATE_SAVE_STAMPS,
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
  const normalized = normalizeSaveKey(key);
  const row = await database.get(
    SELECT_SAVE_RESULT,
    workspaceId,
    canvasId,
    normalized.principalId,
    normalized.operationId,
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
  const key = normalizeSaveKey(result.key);
  await database.run(
    PRUNE_SAVE_RESULTS,
    canvasId,
    canvasId,
    now - SAVE_RESULT_RETENTION_MS,
    SAVE_RESULT_PRUNE_LIMIT,
  );
  const inserted = await database.run(
    INSERT_SAVE_RESULT_IF_ABSENT,
    canvasId,
    key.principalId,
    key.operationId,
    result.digest,
    atVersion,
    now,
    responseJson,
  );
  if (inserted.changes !== 1) {
    throw new PostgresSaveResultRaceError(
      `Result record for ${JSON.stringify(key.operationId)} appeared concurrently`,
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
  const row = await database.get(SELECT_SAVE_HEAD, canvasId);
  if (row === undefined) return;
  const head = decodeSaveHeadRow(row);
  const advanced = advanceStamps(
    stampsOf(head, current.version),
    current.state.nodes,
    next.state.nodes,
    next.version,
  );
  if (advanced.nodes === head.nodes) return;
  await database.run(
    UPDATE_SAVE_STAMPS,
    stringifyJson(advanced.nodes, `Space ${canvasId} stamps`),
    canvasId,
  );
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
            canvasId,
            randomUUID(),
            current.version,
            '{}',
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
      if (!Number.isFinite(input.expectedVersion)) {
        throw new TypeError('expectedVersion must be a finite number');
      }
      const responseJson = validateSaveResult(input.result);
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
          if (state === null) {
            throw new Error(
              `SpaceSave(${canvasId}) cannot record a result for a missing Space`,
            );
          }
          if (state.version !== input.expectedVersion) {
            return {
              ok: false,
              reason: 'version-conflict',
              actualVersion: state.version,
            } as const;
          }
          await insertPostgresSaveResult(
            database,
            canvasId,
            input.result,
            responseJson,
            state.version,
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
