// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  insertSpaceRow,
  occupiedCollisionKeys,
  readSpaceRow,
  stringifyJson,
  updateSpaceRow,
} from './rows.js';
import { putPostgresNodeInTransaction } from './space-nodes.js';
import { allocateSpaceIdentity } from '../sql/identity.js';
import { mutationError, validateInput } from '../sql/write-rules.js';

import type { PostgresStoreContext } from './database.js';
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

    const completed = await context.transaction(async (database) => {
      const current = await readSpaceRow(database, workspaceId, canvasId);
      if (current === null) {
        if (!input.allowCreate) {
          return { ok: false, reason: 'not-found' } as const;
        }
        if (input.expectedVersion !== 0) {
          throw new Error(
            `SpaceWrite(${canvasId}) can create only from version 0`,
          );
        }
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

      if (current.record.version !== input.expectedVersion) {
        return {
          ok: false,
          reason: 'version-conflict',
          actualVersion: current.record.version,
        } as const;
      }
      if (input.nextRecord.createdAt !== current.record.createdAt) {
        throw new Error(`SpaceWrite(${canvasId}) refusing to change createdAt`);
      }
      if (input.nextRecord.title !== current.record.title) {
        throw new Error(
          `SpaceWrite(${canvasId}) cannot change title; ` +
            'use SpaceRepository.rename first',
        );
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
    });
    return completed;
  };
}
