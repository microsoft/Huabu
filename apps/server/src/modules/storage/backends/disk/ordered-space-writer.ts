// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk adapter for the Canvas writer's existing ordered persistence sequence.
 *
 * This is intentionally not a journal or a portable transaction emulator.
 * Node/delta batches retain the pre-existing in-process before-image rollback;
 * record-only writes retain their existing single-file atomic replacement.
 *
 * ⚠️ Nothing between the current-version read and the write may `await`. The
 * single-winner guarantee rests entirely on that stretch running to completion
 * in one uninterrupted JavaScript turn — `read()` and `write()` on the legacy
 * object are synchronous, so no other repository call can observe or overwrite
 * the record in between. Swapping a sync call for `fs/promises` breaks it
 * silently: two writers would capture the same version before yielding, both
 * would find it unchanged on resume, and both would "succeed" while only one
 * write survived. The contract suite catches exactly that by issuing its two
 * writers from one tick against a shared baseline.
 *
 * This holds for the supported single-Server Disk topology. An adapter that
 * cannot honor it structurally — SQLite, Postgres — must use a transaction or
 * a conditional update across all of its connections, or take an explicit
 * lock. A comment is not a mechanism.
 */

import path from 'node:path';

import { runCanvasPersistenceTransaction } from './canvas-persistence-transaction.js';
import { readDiskSpaceRecord } from './space-record-repository.js';
import { canvasFileShapeError } from './space-record-validation.js';
import { getWorkspacePath } from '../../../workspace.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type {
  OrderedNodeMutation,
  OrderedSpaceWriteInput,
  OrderedSpaceWriter,
  SpaceMutationResult,
} from '../../ports/structured.js';

function mutationNodeId(mutation: OrderedNodeMutation): string {
  return mutation.nodeId;
}

function nodeMutationError(
  mutation: OrderedNodeMutation,
  detail: string,
): Error {
  return new Error(
    `Ordered Space write failed for node ${JSON.stringify(mutationNodeId(mutation))}: ${detail}`,
  );
}

export class DiskOrderedSpaceWriter implements OrderedSpaceWriter {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;

  constructor(store: CanvasStore) {
    this.#store = store;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  async apply(input: OrderedSpaceWriteInput): Promise<SpaceMutationResult> {
    this.#assertActiveWorkspace();
    this.#validateInput(input);

    const current = readDiskSpaceRecord(this.#store);
    if (current === null) {
      if (!input.allowCreate) return { ok: false, reason: 'not-found' };
      if (input.expectedVersion !== 0) {
        throw new Error(
          `OrderedSpaceWriter(${this.#store.canvasId}) can create only from version 0`,
        );
      }

      // Preserve the legacy structural PUT's implicit-create path. Executor
      // batches may never manufacture a Space as a side effect.
      this.#store.write(input.nextRecord);
      return { ok: true };
    }

    if (current.version !== input.expectedVersion) {
      return {
        ok: false,
        reason: 'version-conflict',
        actualVersion: current.version,
      };
    }
    if (input.nextRecord.createdAt !== current.createdAt) {
      throw new Error(
        `OrderedSpaceWriter(${this.#store.canvasId}) refusing to change createdAt`,
      );
    }

    if (input.nextRecord.title !== current.title) {
      throw new Error(
        `OrderedSpaceWriter(${this.#store.canvasId}) cannot change title; ` +
          'use SpaceRepository.rename first',
      );
    }
    const nextRecord = input.nextRecord;

    const needsBatchRollback =
      input.nodeMutations.length > 0 || input.delta !== undefined;
    if (!needsBatchRollback) {
      this.#store.write(nextRecord);
      return { ok: true };
    }

    const affectedNodeIds = new Set(input.nodeMutations.map(mutationNodeId));
    const insertedNodeIds = new Set(
      input.nodeMutations.flatMap((mutation) =>
        mutation.kind === 'put' && mutation.authoritativeInsert === true
          ? [mutation.nodeId]
          : [],
      ),
    );

    this.#store.withValidatedNodeMutationTransaction(
      { affectedNodeIds, insertedNodeIds },
      () =>
        runCanvasPersistenceTransaction({
          canvasId: this.#store.canvasId,
          affectedNodeIds,
          nodeIdForFilename: (filename) =>
            this.#store.nodeIdForFilename(filename),
          resetRecordState: () =>
            this.#store.writeNodeMutationRollback(current),
          commit: () => {
            for (const mutation of input.nodeMutations) {
              this.#applyNodeMutation(mutation);
            }
            this.#store.write(nextRecord);
            if (input.delta !== undefined) {
              this.#store.appendDeltaLogEntry(input.delta);
            }
          },
        }),
    );
    return { ok: true };
  }

  #applyNodeMutation(mutation: OrderedNodeMutation): void {
    if (mutation.kind === 'delete') {
      this.#store.deleteNode(mutation.nodeId);
      return;
    }

    // Authoritative inserts are admitted by the enclosing CanvasStore
    // transaction; every other late write still observes the tombstone guard.
    if (this.#store.isNodeWriteSuppressed(mutation.nodeId)) {
      throw nodeMutationError(mutation, 'write is suppressed after deletion');
    }
    const result = this.#store.writeNode(mutation.nodeId, mutation.record, {
      strictRename: mutation.strictLabel,
    });
    if (result.ok) return;

    switch (result.reason) {
      case 'not-found':
        throw nodeMutationError(mutation, 'Space does not exist');
      case 'conflict':
        throw nodeMutationError(
          mutation,
          `name conflicts with node ${JSON.stringify(result.conflictWith.id)}`,
        );
      case 'duplicate':
        throw nodeMutationError(
          mutation,
          `multiple persisted names claim this id: ${result.files.join(', ')}`,
        );
    }
  }

  #validateInput(input: OrderedSpaceWriteInput): void {
    if (!Number.isFinite(input.expectedVersion)) {
      throw new TypeError('expectedVersion must be a finite number');
    }
    const shapeError = canvasFileShapeError(
      input.nextRecord,
      this.#store.canvasId,
    );
    if (shapeError) {
      throw new TypeError(`Invalid next Space record: ${shapeError}`);
    }
    if (input.nextRecord.version !== input.expectedVersion + 1) {
      throw new Error(
        `OrderedSpaceWriter(${this.#store.canvasId}) expected nextRecord.version ` +
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
    for (const mutation of input.nodeMutations) {
      if (
        mutation.kind === 'put' &&
        mutation.record.nodeId !== mutation.nodeId
      ) {
        throw new Error(
          `Node mutation id mismatch: argument=${JSON.stringify(mutation.nodeId)} ` +
            `record=${JSON.stringify(mutation.record.nodeId)}`,
        );
      }
    }
  }

  #assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `OrderedSpaceWriter(${this.#store.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }
}
