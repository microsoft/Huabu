// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SQLite result records and version stamps.
 *
 * The in-transaction helpers are what {@link writeSqliteSpaceInTransaction}
 * calls so a result record and the advanced stamps commit with the state they
 * describe. {@link createSqliteSpaceSave} is the handle's `save` member: the
 * reads, the lazy baseline, and the result record of a write that changed
 * nothing.
 */

import { randomUUID } from 'node:crypto';

import { withImmediateTransaction } from './database.js';
import { storedResultOutcome } from '../../ports/save.js';
import {
  advanceSaveStampsParams,
  checkSaveRecordVersion,
  decodeSaveResultRow,
  decodeSpaceSaveState,
  INSERT_SAVE_HEAD,
  INSERT_SAVE_RESULT,
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

import type { SqliteStoreContext } from './database.js';
import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type {
  SaveKey,
  SaveResult,
  SpaceSave,
  StoredSaveResult,
} from '../../ports/save.js';
import type { DatabaseSync } from 'node:sqlite';

export function readSqliteSaveResult(
  database: DatabaseSync,
  workspaceId: string,
  canvasId: string,
  key: SaveKey,
): StoredSaveResult | null {
  const row = database
    .prepare(SELECT_SAVE_RESULT)
    .get(...saveResultKeyParams(workspaceId, canvasId, key));
  return row === undefined ? null : decodeSaveResultRow(row);
}

/**
 * Store one result record and prune a bounded number of expired ones.
 *
 * Inside the caller's transaction, after the key was found absent.
 */
export function insertSqliteSaveResult(
  database: DatabaseSync,
  canvasId: string,
  result: SaveResult,
  responseJson: string,
  atVersion: number,
  now: number,
): void {
  database
    .prepare(PRUNE_SAVE_RESULTS)
    .run(...pruneSaveResultsParams(canvasId, now));
  database
    .prepare(INSERT_SAVE_RESULT)
    .run(
      ...insertSaveResultParams(canvasId, result, responseJson, atVersion, now),
    );
}

/**
 * Advance the Space's stamps across one record replacement.
 *
 * One indexed lookup when the Space has no baseline — the whole cost of this
 * feature for a Space that never asked for stamps.
 */
export function advanceSqliteStamps(
  database: DatabaseSync,
  canvasId: string,
  current: CanvasFile,
  next: CanvasFile,
): void {
  const update = advanceSaveStampsParams(
    database.prepare(SELECT_SAVE_HEAD).get(canvasId),
    canvasId,
    current,
    next,
  );
  if (update) database.prepare(UPDATE_SAVE_STAMPS).run(...update);
}

/** Bind the `save` member of one SQLite Space handle. */
export function createSqliteSpaceSave(
  context: SqliteStoreContext,
  boundWorkspaceId: string,
  canvasId: string,
): SpaceSave {
  const workspace = (): string =>
    context.assertBoundWorkspace(boundWorkspaceId, `SpaceSave(${canvasId})`);
  const readState = (database: DatabaseSync, workspaceId: string) =>
    decodeSpaceSaveState(
      database.prepare(SELECT_SPACE_SAVE_STATE).get(workspaceId, canvasId),
    );

  return Object.freeze({
    async lookup(key: SaveKey): Promise<StoredSaveResult | null> {
      const workspaceId = workspace();
      return readSqliteSaveResult(
        context.database(),
        workspaceId,
        canvasId,
        key,
      );
    },

    async stamps() {
      const workspaceId = workspace();
      const database = context.database();
      const observed = readState(database, workspaceId);
      if (observed === null) return null;
      if (observed.head) return stampsOf(observed.head, observed.version);

      // Creating the baseline is a mutation, so it honours the deletion fence
      // like every other one; reading an existing baseline above does not.
      context.assertMutationAllowed(canvasId);
      return withImmediateTransaction(database, () => {
        const current = readState(database, workspaceId);
        if (current === null) return null;
        if (!current.head) {
          database
            .prepare(INSERT_SAVE_HEAD)
            .run(...newSaveHeadParams(canvasId, randomUUID(), current.version));
        }
        const settled = readState(database, workspaceId);
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
      const database = context.database();
      return withImmediateTransaction(database, () => {
        const stored = readSqliteSaveResult(
          database,
          workspaceId,
          canvasId,
          input.result.key,
        );
        if (stored) return storedResultOutcome(stored, input.result);
        const state = readState(database, workspaceId);
        const conflict = checkSaveRecordVersion(
          canvasId,
          state,
          input.expectedVersion,
        );
        if (conflict) return conflict;
        insertSqliteSaveResult(
          database,
          canvasId,
          input.result,
          responseJson,
          input.expectedVersion,
          context.now(),
        );
        return { ok: true } as const;
      });
    },
  });
}
