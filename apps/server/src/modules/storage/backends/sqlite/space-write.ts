// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { withImmediateTransaction } from './database.js';
import { allocateSpaceIdentity } from './identity.js';
import {
  insertSpaceRow,
  readSpaceRow,
  stringifyJson,
  updateSpaceRow,
  validateCanvasFile,
  validateNodeContent,
} from './rows.js';
import { putSqliteNodeInTransaction } from './space-nodes.js';
import { sanitizeId } from '../../../../utils/fs.js';

import type { SqliteStoreContext } from './database.js';
import type {
  NodePutResult,
  SpaceHandle,
  SpaceNodeMutation,
  SpaceWriteInput,
  SpaceWriteResult,
} from '../../ports/structured.js';

function mutationError(
  mutation: SpaceNodeMutation,
  result: NodePutResult,
): Error {
  const prefix = `Space write failed for node ${JSON.stringify(mutation.nodeId)}`;
  if (result.ok) return new Error(`${prefix}: unexpected success result`);
  switch (result.reason) {
    case 'not-found':
      return new Error(`${prefix}: Space does not exist`);
    case 'revision-conflict':
      return new Error(`${prefix}: unexpected revision conflict`);
    case 'label-conflict':
      return new Error(
        `${prefix}: label conflicts with node ${JSON.stringify(result.conflictingNodeId)}`,
      );
    case 'duplicate-node':
      return new Error(`${prefix}: duplicate persisted node`);
    case 'write-suppressed':
      return new Error(`${prefix}: write is suppressed after deletion`);
  }
}

function validateInput(canvasId: string, input: SpaceWriteInput): void {
  if (!Number.isFinite(input.expectedVersion)) {
    throw new TypeError('expectedVersion must be a finite number');
  }
  validateCanvasFile(input.nextRecord, canvasId);
  if (input.nextRecord.version !== input.expectedVersion + 1) {
    throw new Error(
      `SpaceWrite(${canvasId}) expected nextRecord.version ` +
        `${input.expectedVersion + 1}, received ${input.nextRecord.version}`,
    );
  }
  if (
    input.allowCreate === true &&
    (input.nodeMutations.length > 0 || input.delta !== undefined)
  ) {
    throw new Error(
      'allowCreate is valid only for a record-only structural write',
    );
  }
  if (
    input.delta !== undefined &&
    input.delta.version !== input.nextRecord.version
  ) {
    throw new Error(
      'delta.version must equal the committed Space record version',
    );
  }
  if (input.delta !== undefined) {
    stringifyJson(input.delta, `Space ${JSON.stringify(canvasId)} delta`);
  }
  for (const mutation of input.nodeMutations) {
    sanitizeId(mutation.nodeId, 'nodeId');
    if (mutation.kind === 'put') {
      validateNodeContent(mutation.record, mutation.nodeId);
    }
  }
}

/** Bind the atomic SQLite record/node/delta write to one Space. */
export function createSqliteSpaceWrite(
  context: SqliteStoreContext,
  canvasId: string,
): SpaceHandle['write'] {
  return async function write(
    input: SpaceWriteInput,
  ): Promise<SpaceWriteResult> {
    context.assertMutationAllowed(canvasId);
    validateInput(canvasId, input);
    const database = context.database();

    const completed = withImmediateTransaction(database, () => {
      const current = readSpaceRow(database, canvasId);
      if (current === null) {
        if (!input.allowCreate) {
          return { ok: false, reason: 'not-found' } as const;
        }
        if (input.expectedVersion !== 0) {
          throw new Error(
            `SpaceWrite(${canvasId}) can create only from version 0`,
          );
        }
        const occupied = database
          .prepare('SELECT collision_key FROM spaces')
          .all()
          .map((row) => row['collision_key'])
          .filter((value): value is string => typeof value === 'string');
        const identity = allocateSpaceIdentity(
          input.nextRecord.title,
          canvasId,
          occupied,
        );
        insertSpaceRow(
          database,
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
          database
            .prepare('DELETE FROM nodes WHERE canvas_id = ? AND node_id = ?')
            .run(canvasId, mutation.nodeId);
          continue;
        }

        const result = putSqliteNodeInTransaction(database, canvasId, {
          nodeId: mutation.nodeId,
          record: mutation.record,
          strictLabel: mutation.strictLabel,
        });
        if (!result.ok) throw mutationError(mutation, result);
      }

      if (
        updateSpaceRow(database, input.nextRecord, input.expectedVersion) !== 1
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
    });
    return completed;
  };
}
