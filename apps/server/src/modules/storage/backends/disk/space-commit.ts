// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Disk implementation of the aggregate Space commit authority. */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  shouldInlineNodeUiProjection,
  type CanvasCommitEvent,
  type NodeChange,
  type NodeUiProjection,
} from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  assertSpaceMutationAllowed,
  withSpaceMutationAdmission,
} from './legacy/space-lifecycle-admission.js';
import { diskNodeSnapshotOf } from './node-repository.js';
import {
  abortPreparedDiskTransaction,
  applyPreparedDiskTransaction,
  captureAppendLogPrefix,
  discardUnappliedDiskTransaction,
  finalizeCommittedDiskTransaction,
  finalizeCommittedDiskTransactionBestEffort,
  isPreparedDiskTransactionCommitted,
  markPreparedDiskTransactionCommitted,
  prepareDiskTransaction,
  validatePreparedDiskTransactionUnapplied,
  withDiskTransactionWorkspaceLock,
} from './transaction-journal.js';
import { repairJsonLinesTail } from '../../../../utils/fs.js';
import { structureRevisionOf } from '../../../canvas/structure-revision.js';
import { isWorldCanvasId } from '../../../workspace/disk/canvas-dirs.js';
import {
  normalizeForCompare,
  toSafeFilename,
} from '../../../workspace/disk/naming.js';
import {
  canvasRoot,
  deltaLogPath,
  SPACE_JSON_FILENAME,
} from '../../../workspace/disk/paths.js';
import { withSpaceDirHandlesReleased } from '../../../workspace/disk/space-dir-handles.js';
import { getWorkspacePath } from '../../../workspace.js';

import type {
  CanvasStore,
  NodeMutationTombstoneSettlement,
} from './legacy/canvas-store.js';
import type {
  PrepareDiskTransactionInput,
  PreparedDiskTransaction,
} from './transaction-journal.js';
import type {
  CanvasFile,
  DeltaLogEntry,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type {
  NodeRecordRevision,
  NodeSnapshot,
  SpaceCommitInput,
  SpaceCommitResult,
  SpaceNodeMutation,
} from '../../ports/structured.js';

/** Injectable only so adapter failure tests can stop at journal boundaries. */
export interface DiskCommitJournal {
  prepare(input: PrepareDiskTransactionInput): PreparedDiskTransaction;
  validateUnapplied(handle: PreparedDiskTransaction): void;
  discard(handle: PreparedDiskTransaction): void;
  apply(handle: PreparedDiskTransaction): void;
  markCommitted(handle: PreparedDiskTransaction): void;
  finalize(handle: PreparedDiskTransaction): void;
  abort(handle: PreparedDiskTransaction): void;
}

const defaultJournal: DiskCommitJournal = {
  prepare: prepareDiskTransaction,
  validateUnapplied: validatePreparedDiskTransactionUnapplied,
  discard: discardUnappliedDiskTransaction,
  apply: applyPreparedDiskTransaction,
  markCommitted: markPreparedDiskTransactionCommitted,
  finalize: finalizeCommittedDiskTransaction,
  abort: abortPreparedDiskTransaction,
};

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function readBytesOrNull(filePath: string): Buffer | null {
  try {
    return readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const commitChains = new Map<string, Promise<unknown>>();

function idOf(value: unknown): string | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

function idsOf(values: readonly unknown[]): string[] {
  return values.flatMap((value) => {
    const id = idOf(value);
    return id === null ? [] : [id];
  });
}

function topologyTypesOf(values: readonly unknown[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const id = idOf(value);
    const type = (value as { type?: unknown } | null)?.type;
    if (id !== null && typeof type === 'string') result.set(id, type);
  }
  return result;
}

function sameOrder(
  before: readonly unknown[],
  after: readonly unknown[],
): boolean {
  const left = idsOf(before);
  const right = idsOf(after);
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function uiProjection(record: NodeContent): NodeUiProjection {
  const projection: NodeUiProjection = {
    type: record.type,
    label: record.label,
    content: record.content,
    rev: nodeRevisionOf({
      ...(typeof record.content === 'string'
        ? { content: record.content }
        : {}),
      ...(typeof record.src === 'string' ? { src: record.src } : {}),
    }),
  };
  const optional = [
    'labelSource',
    'src',
    'summary',
    'keywords',
    'provenance',
    'contentMissing',
    'artifactMissing',
    'contentDuplicate',
    'duplicateFiles',
  ] as const;
  for (const key of optional) {
    const value = record[key];
    if (value !== undefined) {
      (projection as Record<string, unknown>)[key] = value;
    }
  }
  return projection;
}

function nodeChangeOf(snapshot: NodeSnapshot): NodeChange {
  const projection = uiProjection(snapshot.record);
  return shouldInlineNodeUiProjection(projection)
    ? {
        kind: 'inline',
        nodeId: snapshot.record.nodeId,
        recordRevision: snapshot.revision,
        projection,
      }
    : {
        kind: 'invalidate',
        nodeId: snapshot.record.nodeId,
        recordRevision: snapshot.revision,
      };
}

function mutationNodeId(mutation: SpaceNodeMutation): string {
  return mutation.kind === 'put' ? mutation.record.nodeId : mutation.nodeId;
}

class CommitBusinessConflict extends Error {
  constructor(readonly result: Extract<SpaceCommitResult, { ok: false }>) {
    super(result.reason);
  }
}

async function withCommitLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = commitChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  commitChains.set(key, next);
  try {
    return await next;
  } finally {
    if (commitChains.get(key) === next) commitChains.delete(key);
  }
}

export class DiskSpaceCommitter {
  readonly #store: CanvasStore;
  readonly #workspacePath: string;
  readonly #journal: DiskCommitJournal;

  constructor(store: CanvasStore, journal: DiskCommitJournal = defaultJournal) {
    this.#store = store;
    this.#journal = journal;
    this.#workspacePath = path.resolve(getWorkspacePath());
  }

  commit(input: SpaceCommitInput): Promise<SpaceCommitResult> {
    const key = `${this.#workspacePath}\0${this.#store.canvasId}`;
    // A mutation that starts after delete was admitted must fail instead of
    // queueing behind it: otherwise delete can wait on the caller that is in
    // turn waiting for this commit to finish.
    assertSpaceMutationAllowed(this.#workspacePath, this.#store.canvasId);
    return withSpaceMutationAdmission(
      this.#workspacePath,
      this.#store.canvasId,
      () =>
        withCommitLock(key, () =>
          withDiskTransactionWorkspaceLock(this.#workspacePath, () =>
            this.#commitLocked(input),
          ),
        ),
    );
  }

  async #commitLocked(input: SpaceCommitInput): Promise<SpaceCommitResult> {
    if (path.resolve(getWorkspacePath()) !== this.#workspacePath) {
      throw new Error(
        `SpaceCommit(${this.#store.canvasId}) belongs to an inactive workspace. ` +
          'Resolve a fresh Space handle after workspace activation.',
      );
    }

    const persistedCurrent = this.#store.readPersisted();
    if (persistedCurrent === null) return { ok: false, reason: 'not-found' };
    const current = this.#store.reconcileValidatedRecord(persistedCurrent);
    if (current.version !== input.expectedVersion) {
      return {
        ok: false,
        reason: 'version-conflict',
        actualVersion: current.version,
        structureRevision: structureRevisionOf(current),
      };
    }

    const mutationIds = input.nodeMutations.map(mutationNodeId);
    if (new Set(mutationIds).size !== mutationIds.length) {
      throw new Error('SpaceCommit contains more than one mutation for a node');
    }
    const preconditions = new Map(
      input.nodePreconditions.map((entry) => [entry.nodeId, entry.revision]),
    );
    if (
      preconditions.size !== input.nodePreconditions.length ||
      mutationIds.some((nodeId) => !preconditions.has(nodeId)) ||
      preconditions.size !== mutationIds.length
    ) {
      throw new Error(
        'SpaceCommit requires exactly one whole-record precondition per node mutation',
      );
    }

    // A sidecar is part of the Space aggregate, never an independently
    // visible entity. Validate against the proposed topology at the adapter
    // boundary so a stale route/preprocess result cannot create an orphan or
    // revert frontmatter type after a structural type transition.
    const nextTopologyTypes = topologyTypesOf(input.record.state.nodes);
    for (const mutation of input.nodeMutations) {
      if (mutation.kind !== 'put') continue;
      const topologyType =
        nextTopologyTypes.get(mutation.record.nodeId) ?? null;
      if (topologyType !== mutation.record.type) {
        return {
          ok: false,
          reason: 'node-topology-conflict',
          nodeId: mutation.record.nodeId,
          mutationType: mutation.record.type,
          topologyType,
        };
      }
    }

    const beforeNodes = new Map<string, NodeSnapshot>();
    for (const nodeId of mutationIds) {
      this.#store.revalidateNodeForRead(nodeId);
      if (this.#store.isDuplicateNode(nodeId)) {
        return {
          ok: false,
          reason: 'duplicate-node',
          nodeId,
          logicalNames: this.#store.duplicateNodeFiles(nodeId).sort(),
        };
      }
      const record = this.#store.readNode(nodeId);
      let snapshot: NodeSnapshot | null = null;
      if (record !== null) {
        snapshot = diskNodeSnapshotOf(
          record,
          this.#store.nodeLogicalName(nodeId),
        );
        beforeNodes.set(nodeId, snapshot);
      }
      // Presence was proven by the exact-key validation above; retain `null`
      // as the meaningful "must be absent" baseline.
      const expected = preconditions.get(nodeId) as NodeRecordRevision | null;
      const actual = snapshot?.revision ?? null;
      if (expected !== actual) {
        return {
          ok: false,
          reason: 'node-conflict',
          nodeId,
          actualRevision: actual,
        };
      }
    }

    const directoryTitleChanged = current.title !== input.record.title;
    const durableTitleChanged = persistedCurrent.title !== input.record.title;
    if (directoryTitleChanged && isWorldCanvasId(this.#store.canvasId)) {
      return { ok: false, reason: 'world-title-forbidden' };
    }

    const effectiveMutations = input.nodeMutations.filter((mutation) => {
      const before = beforeNodes.get(mutationNodeId(mutation));
      if (mutation.kind === 'delete') return before !== undefined;
      return (
        before === undefined ||
        !isDeepStrictEqual(before.record, mutation.record)
      );
    });
    const recordChanged =
      durableTitleChanged ||
      !isDeepStrictEqual(current.state, input.record.state);
    const shouldCommit =
      input.forceVersionBump === true ||
      recordChanged ||
      effectiveMutations.length > 0;
    const commitId = randomUUID();

    if (!shouldCommit) {
      // Deleting an already-absent sidecar is a semantic no-op, but it still
      // establishes the Disk anti-resurrection guard. A slow content PUT or
      // preprocess that started before DELETE must not recreate the file
      // after topology drops the node. Tombstones are backend metadata, not
      // a user-visible node mutation, so this deliberately does not advance
      // the Space version or append a publication row.
      for (const mutation of input.nodeMutations) {
        if (mutation.kind === 'delete' && !beforeNodes.has(mutation.nodeId)) {
          this.#store.deleteNode(mutation.nodeId);
        }
      }
      const event: CanvasCommitEvent = {
        commitId,
        fromVersion: current.version,
        toVersion: current.version,
        structureRevision: structureRevisionOf(current),
        originator: input.publication.originator,
        optimistic: input.publication.optimistic,
        recordChanged: false,
        structureDeltas: [],
        nodeChanges: [],
      };
      return { ok: true, committed: false, record: current, event, nodes: [] };
    }

    const currentIds = new Set(idsOf(current.state.nodes));
    const nextIds = new Set(idsOf(input.record.state.nodes));
    for (const mutation of effectiveMutations) {
      const nodeId = mutationNodeId(mutation);
      const isAggregateInsert = !currentIds.has(nodeId) && nextIds.has(nodeId);
      if (
        mutation.kind === 'put' &&
        !isAggregateInsert &&
        !currentIds.has(nodeId) &&
        this.#store.isNodeWriteSuppressed(nodeId)
      ) {
        return { ok: false, reason: 'node-write-suppressed', nodeId };
      }
    }

    const fromVersion = current.version;
    const toVersion = fromVersion + 1;
    const nextRecord: CanvasFile = {
      ...current,
      title: input.record.title,
      state: input.record.state,
      version: toVersion,
      updatedAt: Date.now(),
    };
    // An absent sidecar delete is not an effective record mutation, but when
    // it accompanies a topology/version commit it must still run inside the
    // validated transaction so the tombstone is committed (or rolled back)
    // with the aggregate.
    const transactionMutations = input.nodeMutations.filter(
      (mutation) =>
        mutation.kind === 'delete' || effectiveMutations.includes(mutation),
    );
    const affectedNodeIds = new Set(transactionMutations.map(mutationNodeId));
    const insertedNodeIds = new Set(
      effectiveMutations.flatMap((mutation) => {
        const nodeId = mutationNodeId(mutation);
        return mutation.kind === 'put' &&
          !currentIds.has(nodeId) &&
          nextIds.has(nodeId)
          ? [nodeId]
          : [];
      }),
    );
    const resurrectedNodeIds = new Set(
      [...nextIds].filter((nodeId) => !currentIds.has(nodeId)),
    );

    const beforeRootRelativePath = path.basename(
      canvasRoot(this.#store.canvasId),
    );
    const afterRootRelativePath = toSafeFilename(
      input.record.title,
      this.#store.canvasId,
    );
    const directory =
      directoryTitleChanged && beforeRootRelativePath !== afterRootRelativePath
        ? {
            kind: 'rename' as const,
            beforeRootRelativePath,
            afterRootRelativePath,
          }
        : {
            kind: 'none' as const,
            rootRelativePath: beforeRootRelativePath,
          };
    const runSynchronousCommit = (): SpaceCommitResult => {
      let journal: PreparedDiskTransaction | null = null;
      let journalCommitted = false;
      let liveMutationStarted = false;
      const tombstoneSettlement: {
        current: NodeMutationTombstoneSettlement | null;
      } = { current: null };

      const discardPrepared = (): void => {
        if (journal === null) return;
        this.#journal.discard(journal);
        journal = null;
        this.#store.invalidateNodeIndexAfterTransactionRecovery();
      };

      try {
        const committed = this.#store.withValidatedNodeMutationTransaction(
          {
            affectedNodeIds,
            insertedNodeIds,
            deferTombstoneSettlement: (settlement) => {
              tombstoneSettlement.current = settlement;
            },
          },
          () => {
            // Watcher handles have already been released. Take the final OCC
            // snapshot now, while no promise boundary can admit another local
            // writer, and do not capture an undo journal until it passes.
            const persistedLatest = this.#store.readPersisted();
            if (persistedLatest === null) {
              throw new CommitBusinessConflict({
                ok: false,
                reason: 'not-found',
              });
            }
            const latest =
              this.#store.reconcileValidatedRecord(persistedLatest);
            if (
              latest.version !== input.expectedVersion ||
              !isDeepStrictEqual(persistedLatest, persistedCurrent) ||
              !isDeepStrictEqual(latest, current)
            ) {
              throw new CommitBusinessConflict({
                ok: false,
                reason: 'version-conflict',
                actualVersion: latest.version,
                structureRevision: structureRevisionOf(latest),
              });
            }

            // A fresh scan is part of the final persistence plan. In particular,
            // a sibling created while watcher release was in flight must be
            // either surfaced as a strict conflict or included in the chosen
            // non-strict dedupe target before the undo journal is captured.
            const planned =
              this.#store.planNodeMutationsForJournal(transactionMutations);
            if (!planned.ok) {
              if (planned.reason === 'conflict') {
                throw new CommitBusinessConflict({
                  ok: false,
                  reason: 'node-name-conflict',
                  nodeId: planned.nodeId,
                  conflictWith: {
                    id: planned.conflictWith.id,
                    logicalName: planned.conflictWith.filename,
                  },
                });
              }
              throw new CommitBusinessConflict({
                ok: false,
                reason: 'duplicate-node',
                nodeId: planned.nodeId,
                logicalNames: planned.files,
              });
            }
            for (const nodeId of mutationIds) {
              const latestNode = this.#store.readNode(nodeId);
              const duplicateLogicalNames = this.#store.isDuplicateNode(nodeId)
                ? this.#store.duplicateNodeFiles(nodeId).sort()
                : undefined;
              const actualRevision =
                latestNode === null
                  ? null
                  : diskNodeSnapshotOf(
                      latestNode,
                      this.#store.nodeLogicalName(nodeId),
                      duplicateLogicalNames,
                    ).revision;
              const expectedRevision = preconditions.get(
                nodeId,
              ) as NodeRecordRevision | null;
              if (actualRevision !== expectedRevision) {
                throw new CommitBusinessConflict({
                  ok: false,
                  reason: 'node-conflict',
                  nodeId,
                  actualRevision,
                });
              }
            }

            const plannedByNodeId = new Map(
              planned.plan.mutations.map((mutation) => [
                mutation.nodeId,
                mutation,
              ]),
            );
            const finalNodes = effectiveMutations.flatMap((mutation) => {
              if (mutation.kind === 'delete') return [];
              const nodePlan = plannedByNodeId.get(mutation.record.nodeId);
              if (nodePlan === undefined || nodePlan.kind !== 'put') {
                throw new Error(
                  `Missing Disk node mutation plan for ${mutation.record.nodeId}`,
                );
              }
              return [
                diskNodeSnapshotOf(nodePlan.record, nodePlan.targetFilename),
              ];
            });
            const snapshots = new Map(
              finalNodes.map((snapshot) => [snapshot.record.nodeId, snapshot]),
            );
            const nodeChanges: NodeChange[] = effectiveMutations.flatMap(
              (mutation) => {
                if (mutation.kind === 'delete') {
                  return beforeNodes.has(mutation.nodeId)
                    ? [{ kind: 'delete' as const, nodeId: mutation.nodeId }]
                    : [];
                }
                const snapshot = snapshots.get(mutation.record.nodeId);
                return snapshot === undefined ? [] : [nodeChangeOf(snapshot)];
              },
            );
            const structureRevision = structureRevisionOf(nextRecord);
            const event: CanvasCommitEvent = {
              commitId,
              fromVersion,
              toVersion,
              structureRevision,
              originator: input.publication.originator,
              optimistic: input.publication.optimistic,
              recordChanged: true,
              structureDeltas: [...input.publication.structureDeltas],
              ...(durableTitleChanged ? { title: nextRecord.title } : {}),
              ...(!sameOrder(current.state.nodes, nextRecord.state.nodes)
                ? { nodeOrder: idsOf(nextRecord.state.nodes) }
                : {}),
              ...(!sameOrder(current.state.edges, nextRecord.state.edges)
                ? { edgeOrder: idsOf(nextRecord.state.edges) }
                : {}),
              nodeChanges,
            };
            const deltaEntry: DeltaLogEntry = {
              version: toVersion,
              ts: Date.now(),
              ...(input.publication.runId
                ? { runId: input.publication.runId }
                : {}),
              commands: [...input.publication.commands],
              deltas: [...input.publication.structureDeltas],
              originator: input.publication.originator,
              commit: event,
            };

            // Normalize a pre-existing crash fragment before declaring the
            // exact append prefix owned by this transaction. From prepare
            // through the first live mutation there is no promise boundary.
            const appendRelativePath = '.history/delta-log.jsonl';
            repairJsonLinesTail(deltaLogPath(this.#store.canvasId));
            const appendPrefix = captureAppendLogPrefix(
              this.#workspacePath,
              beforeRootRelativePath,
              appendRelativePath,
            );
            const beforeRootPath = path.join(
              this.#workspacePath,
              beforeRootRelativePath,
            );
            const nodeFiles = this.#store.materializeNodeMutationPlan(
              planned.plan,
            );
            journal = this.#journal.prepare({
              workspacePath: this.#workspacePath,
              transactionId: commitId,
              directory,
              files: [
                {
                  relativePath: SPACE_JSON_FILENAME,
                  before: readBytesOrNull(
                    path.join(beforeRootPath, SPACE_JSON_FILENAME),
                  ),
                  after: jsonBytes(nextRecord),
                },
                ...nodeFiles.map(({ filename, after }) => ({
                  relativePath: `nodes/${filename}`,
                  before: readBytesOrNull(
                    path.join(beforeRootPath, 'nodes', filename),
                  ),
                  after,
                })),
              ],
              append: {
                relativePath: appendRelativePath,
                ...appendPrefix,
                bytes: Buffer.from(`${JSON.stringify(deltaEntry)}\n`, 'utf8'),
              },
            });

            // Preparing the immutable redo payload can race a different
            // process. Re-prove directory state, the record version, every
            // whole-node revision, the filename plan, and finally the exact
            // raw before-bytes. A stale journal is discarded without replaying
            // its captured bytes because this transaction has not written yet.
            if (directory.kind === 'rename') {
              const beforePath = path.join(
                this.#workspacePath,
                directory.beforeRootRelativePath,
              );
              const afterPath = path.join(
                this.#workspacePath,
                directory.afterRootRelativePath,
              );
              if (!existsSync(beforePath)) {
                discardPrepared();
                throw new CommitBusinessConflict({
                  ok: false,
                  reason: 'not-found',
                });
              }
              if (
                normalizeForCompare(directory.beforeRootRelativePath) !==
                  normalizeForCompare(directory.afterRootRelativePath) &&
                existsSync(afterPath)
              ) {
                discardPrepared();
                throw new CommitBusinessConflict({
                  ok: false,
                  reason: 'title-conflict',
                  conflictWith: directory.afterRootRelativePath,
                });
              }
            }

            const persistedAfterPrepare = this.#store.readPersisted();
            if (persistedAfterPrepare === null) {
              discardPrepared();
              throw new CommitBusinessConflict({
                ok: false,
                reason: 'not-found',
              });
            }
            const latestAfterPrepare = this.#store.reconcileValidatedRecord(
              persistedAfterPrepare,
            );
            if (
              latestAfterPrepare.version !== input.expectedVersion ||
              !isDeepStrictEqual(persistedAfterPrepare, persistedLatest) ||
              !isDeepStrictEqual(latestAfterPrepare, latest)
            ) {
              discardPrepared();
              throw new CommitBusinessConflict({
                ok: false,
                reason: 'version-conflict',
                actualVersion: latestAfterPrepare.version,
                structureRevision: structureRevisionOf(latestAfterPrepare),
              });
            }

            const verified =
              this.#store.planNodeMutationsForJournal(transactionMutations);
            if (
              !verified.ok ||
              !isDeepStrictEqual(verified.plan, planned.plan)
            ) {
              discardPrepared();
              if (!verified.ok && verified.reason === 'conflict') {
                throw new CommitBusinessConflict({
                  ok: false,
                  reason: 'node-name-conflict',
                  nodeId: verified.nodeId,
                  conflictWith: {
                    id: verified.conflictWith.id,
                    logicalName: verified.conflictWith.filename,
                  },
                });
              }
              if (!verified.ok) {
                throw new CommitBusinessConflict({
                  ok: false,
                  reason: 'duplicate-node',
                  nodeId: verified.nodeId,
                  logicalNames: verified.files,
                });
              }
              throw new Error('Disk node mutation filename plan changed');
            }

            for (const nodeId of mutationIds) {
              const latestNode = this.#store.readNode(nodeId);
              const duplicateLogicalNames = this.#store.isDuplicateNode(nodeId)
                ? this.#store.duplicateNodeFiles(nodeId).sort()
                : undefined;
              const actualRevision =
                latestNode === null
                  ? null
                  : diskNodeSnapshotOf(
                      latestNode,
                      this.#store.nodeLogicalName(nodeId),
                      duplicateLogicalNames,
                    ).revision;
              const expectedRevision = preconditions.get(
                nodeId,
              ) as NodeRecordRevision | null;
              if (actualRevision !== expectedRevision) {
                discardPrepared();
                throw new CommitBusinessConflict({
                  ok: false,
                  reason: 'node-conflict',
                  nodeId,
                  actualRevision,
                });
              }
            }

            this.#journal.validateUnapplied(journal);

            if (directoryTitleChanged) {
              const rename = this.#store.renameSelf(input.record.title);
              if (!rename.ok) {
                const sourceStillExists =
                  directory.kind !== 'rename' ||
                  existsSync(
                    path.join(
                      this.#workspacePath,
                      directory.beforeRootRelativePath,
                    ),
                  );
                const destinationNowExists =
                  directory.kind === 'rename' &&
                  normalizeForCompare(directory.beforeRootRelativePath) !==
                    normalizeForCompare(directory.afterRootRelativePath) &&
                  existsSync(
                    path.join(
                      this.#workspacePath,
                      directory.afterRootRelativePath,
                    ),
                  );
                discardPrepared();
                if (rename.reason === 'conflict' || destinationNowExists) {
                  throw new CommitBusinessConflict({
                    ok: false,
                    reason: 'title-conflict',
                    conflictWith:
                      rename.reason === 'conflict'
                        ? rename.conflictWith
                        : directory.kind === 'rename'
                          ? directory.afterRootRelativePath
                          : toSafeFilename(
                              input.record.title,
                              this.#store.canvasId,
                            ),
                  });
                }
                if (rename.reason === 'not-found' || !sourceStillExists) {
                  throw new CommitBusinessConflict({
                    ok: false,
                    reason: 'not-found',
                  });
                }
                if (rename.reason === 'forbidden') {
                  throw new CommitBusinessConflict({
                    ok: false,
                    reason: 'world-title-forbidden',
                  });
                }
                throw new Error(rename.message);
              }
              if (directory.kind === 'rename') liveMutationStarted = true;
            }

            liveMutationStarted = true;
            // Keep the legacy publication seam as the first journal-owned
            // append. The deterministic apply below recognizes this exact
            // declared tail as already-redone, while injected failures here
            // still roll the append, files, and optional rename back together.
            this.#store.appendDeltaLogEntry(deltaEntry);
            this.#journal.apply(journal);
            this.#store.invalidateNodeIndexAfterTransactionRecovery();
            this.#store.stageNodeMutationTombstones(
              planned.plan.mutations,
              resurrectedNodeIds,
            );
            return {
              ok: true as const,
              committed: true,
              record: nextRecord,
              event,
              nodes: finalNodes,
            };
          },
        );
        if (journal === null) {
          throw new Error('Disk Space commit completed without a journal');
        }
        try {
          this.#journal.markCommitted(journal);
        } catch (error) {
          // The marker rename is the decision boundary. If an injected or
          // process-local error arrives immediately afterward, the durable
          // decision still wins and the operation must report success.
          if (!isPreparedDiskTransactionCommitted(journal)) throw error;
        }
        journalCommitted = true;
        try {
          tombstoneSettlement.current?.commit();
        } catch {
          // A retained tombstone is safe while topology lists the node (the
          // write guard's live-presence escape hatch applies) and expires on
          // its own. Metadata cleanup cannot reverse a durable aggregate
          // commit.
        }
        finalizeCommittedDiskTransactionBestEffort(journal, (handle) =>
          this.#journal.finalize(handle),
        );
        return committed;
      } catch (error) {
        if (!journalCommitted && journal !== null) {
          try {
            // This runs inside the same released-handle callback as rename,
            // which keeps Windows rollback renames out of EPERM territory.
            if (liveMutationStarted) this.#journal.abort(journal);
            else this.#journal.discard(journal);
          } finally {
            tombstoneSettlement.current?.rollback();
            this.#store.invalidateNodeIndexAfterTransactionRecovery();
          }
        }
        if (error instanceof CommitBusinessConflict) return error.result;
        throw error;
      }
    };

    if (!directoryTitleChanged) return runSynchronousCommit();
    return withSpaceDirHandlesReleased(this.#store.canvasId, () =>
      runSynchronousCommit(),
    );
  }
}
