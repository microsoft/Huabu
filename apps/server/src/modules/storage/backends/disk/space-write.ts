// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk implementation of {@link SpaceHandle.write}.
 *
 * This is intentionally not a journal or a portable transaction emulator.
 * Node/delta batches retain the pre-existing in-process before-image rollback;
 * record-only writes retain their existing single-file atomic replacement.
 *
 * A write that carries a result record is additionally bracketed by a
 * write-ahead intent, and a Space with a stamp baseline has its stamps
 * advanced inside the same rollback scope; both live in `space-save.ts`. A
 * write that carries no result, to a Space with no baseline, pays one `stat`
 * for the privilege of doing neither.
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
import { canvasFileShapeError } from './space-record-validation.js';
import { readDiskSpaceRecord } from './space-record.js';
import { advanceDiskStamps, DiskSpaceSaveState } from './space-save.js';
import { getWorkspacePath } from '../../../workspace.js';
import {
  storedResultOutcome,
  validateWriteSaveResult,
} from '../../ports/save.js';

import type { CanvasStore } from './legacy/canvas-store.js';
import type { DiskSaveOptions } from './space-save.js';
import type {
  SpaceHandle,
  SpaceNodeMutation,
  SpaceWriteInput,
  SpaceWriteResult,
} from '../../ports/structured.js';

function mutationNodeId(mutation: SpaceNodeMutation): string {
  return mutation.nodeId;
}

function nodeMutationError(mutation: SpaceNodeMutation, detail: string): Error {
  return new Error(
    `Space write failed for node ${JSON.stringify(mutationNodeId(mutation))}: ${detail}`,
  );
}

/**
 * Bind the ordered write to one Space.
 *
 * A closure rather than a class: this is the Space's write action, so the only
 * thing it needs to own is the store it writes through and the Workspace it
 * was resolved in.
 */
export function createDiskSpaceWrite(
  store: CanvasStore,
  saveOptions: DiskSaveOptions = {},
): SpaceHandle['write'] {
  const boundWorkspacePath = path.resolve(getWorkspacePath());
  const save = new DiskSpaceSaveState(store, saveOptions);

  function assertActiveWorkspace(): void {
    if (path.resolve(getWorkspacePath()) !== boundWorkspacePath) {
      throw new Error(
        `SpaceWrite(${store.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }
  }

  function validateInput(input: SpaceWriteInput): void {
    if (!Number.isFinite(input.expectedVersion)) {
      throw new TypeError('expectedVersion must be a finite number');
    }
    const shapeError = canvasFileShapeError(input.nextRecord, store.canvasId);
    if (shapeError) {
      throw new TypeError(`Invalid next Space record: ${shapeError}`);
    }
    if (input.nextRecord.version !== input.expectedVersion + 1) {
      throw new Error(
        `SpaceWrite(${store.canvasId}) expected nextRecord.version ` +
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

  function applyNodeMutation(mutation: SpaceNodeMutation): void {
    if (mutation.kind === 'delete') {
      store.deleteNode(mutation.nodeId);
      return;
    }

    // Authoritative inserts are admitted by the enclosing CanvasStore
    // transaction; every other late write still observes the tombstone guard.
    if (store.isNodeWriteSuppressed(mutation.nodeId)) {
      throw nodeMutationError(mutation, 'write is suppressed after deletion');
    }
    const result = store.writeNode(mutation.nodeId, mutation.record, {
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

  return async function write(
    input: SpaceWriteInput,
  ): Promise<SpaceWriteResult> {
    assertActiveWorkspace();
    validateInput(input);
    const responseJson = validateWriteSaveResult(input);

    // Everything from here to the end of the write is synchronous, including
    // recovery and the stored-result check: see the module note.
    const saveInUse = save.inUse();
    if (saveInUse) {
      save.recoverPending();
      if (input.result !== undefined) {
        // Before the version check: a retry of a committed write arrives with
        // a stale expected version and must be answered, not refused.
        const stored = save.readResult(input.result.key);
        if (stored) return storedResultOutcome(stored, input.result);
      }
    }

    const current = readDiskSpaceRecord(store);
    if (current === null) {
      if (!input.allowCreate) return { ok: false, reason: 'not-found' };
      if (input.expectedVersion !== 0) {
        throw new Error(
          `SpaceWrite(${store.canvasId}) can create only from version 0`,
        );
      }

      // Preserve the legacy structural PUT's implicit-create path. Executor
      // batches may never manufacture a Space as a side effect.
      store.write({
        ...input.nextRecord,
        parentSpaceId: null,
        parentEntryNodeId: null,
      });
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
        `SpaceWrite(${store.canvasId}) refusing to change createdAt`,
      );
    }
    if (input.nextRecord.title !== current.title) {
      throw new Error(
        `SpaceWrite(${store.canvasId}) cannot change title; ` +
          'use SpaceRepository.rename first',
      );
    }
    const nextRecord = {
      ...input.nextRecord,
      parentSpaceId: current.parentSpaceId,
      parentEntryNodeId: current.parentEntryNodeId,
    };

    const nextStamps = saveInUse
      ? advanceDiskStamps(save, current, nextRecord)
      : null;
    const pending =
      input.result !== undefined && responseJson !== null
        ? save.begin({
            result: input.result,
            responseJson,
            expectedVersion: input.expectedVersion,
            toVersion: nextRecord.version,
            delta: input.delta,
            stamps: nextStamps,
          })
        : null;

    const needsBatchRollback =
      input.nodeMutations.length > 0 || input.delta !== undefined;
    if (!needsBatchRollback) {
      try {
        store.write(nextRecord);
      } catch (error) {
        if (pending) save.settleAfterFailure();
        throw error;
      }
      save.stage('record');
      if (nextStamps) {
        try {
          save.writeHead(nextStamps);
        } catch (error) {
          // The record is already replaced and this path has no rollback. An
          // intent finishes the stamps on the next call; without one the
          // stale head is detected by its version and re-based. Either way
          // the write itself succeeded only if its result can be stored.
          if (pending) throw error;
        }
        save.stage('head');
      }
      if (pending) save.finish(pending);
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

    try {
      store.withValidatedNodeMutationTransaction(
        { affectedNodeIds, insertedNodeIds },
        () =>
          runCanvasPersistenceTransaction({
            canvasId: store.canvasId,
            affectedNodeIds,
            nodeIdForFilename: (filename) => store.nodeIdForFilename(filename),
            resetRecordState: () => store.writeNodeMutationRollback(current),
            commit: () => {
              for (const mutation of input.nodeMutations) {
                applyNodeMutation(mutation);
              }
              save.stage('sidecars');
              store.write(nextRecord);
              save.stage('record');
              if (input.delta !== undefined) {
                store.appendDeltaLogEntry(input.delta);
              }
              save.stage('delta');
              // Last, so that a failure here still rolls the record back and
              // nothing after it can fail inside this scope.
              if (nextStamps) save.writeHead(nextStamps);
              save.stage('head');
            },
          }),
      );
    } catch (error) {
      if (pending) save.settleAfterFailure();
      throw error;
    }
    if (pending) save.finish(pending);
    return { ok: true };
  };
}
