// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import {
  canvasCommitQuerySchema,
  canvasOperationMetadataSchema,
  canvasOperationReceiptSchema,
  canvasOperationSessionSchema,
} from '@huabu/shared';
import {
  coalesceChanges,
  type CanvasChangeRecord,
} from '@huabu/shared/canvas-engine';

import { canvasRoot } from './layout.js';
import {
  markdownToNodeContent,
  nodeContentToMarkdown,
} from './legacy/canvas-store.js';
import {
  DiskOperationRedo,
  diskBytesDigest,
  readOperationFile,
} from './operation-redo.js';
import { canvasFileShapeError } from './space-record-validation.js';
import {
  resolveDirectChildPath,
  safeJoin,
  sanitizeId,
} from '../../../../utils/fs.js';
import { stringifyJson } from '../../../../utils/json.js';
import {
  dedupeArtifactFilename,
  toSafeFilename,
} from '../../../../utils/naming.js';
import { getWorkspaceHandle, getWorkspacePath } from '../../../workspace.js';
import {
  newOperationSession,
  operationDigest,
  operationReplayPage,
  validateOperationWrite,
} from '../../ports/operation-rules.js';
import { SpaceOperationError } from '../../ports/operations.js';
import { assertSpaceMutationAllowed } from '../../space-lifecycle-admission.js';

import type { DiskOperationProjection } from './operation-redo.js';
import type {
  CanvasFile,
  NodeContent,
} from '../../../canvas/persistence-types.js';
import type {
  SpaceOperationKey,
  SpaceOperationSnapshot,
  SpaceOperationStore,
} from '../../ports/operations.js';
import type { CanvasOperationLookup } from '@huabu/shared';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const diskOperationHeadSchema = z
  .object({
    workspaceId: z.string().min(1),
    canvasId: z.string().min(1),
    metadata: canvasOperationMetadataSchema,
    recordDigest: digestSchema,
    sidecars: z.record(
      z.string().min(1),
      z
        .object({
          filename: z.string().min(1),
          digest: digestSchema,
        })
        .strict(),
    ),
    reviews: z.record(z.string().min(1), digestSchema),
  })
  .strict();
const sessionSchema = z
  .object({
    principalId: z.string().min(1),
    session: canvasOperationSessionSchema,
  })
  .strict();
const receiptSchema = z
  .object({
    digest: digestSchema,
    receipt: canvasOperationReceiptSchema,
  })
  .strict();

/** Workspace-owned receipts survive removal of the Space directory. No activation/migration entry. */
export function createDiskSpaceOperations(
  canvasIdInput: string,
  now: () => number = Date.now,
  onStage?: (stage: string) => void,
): SpaceOperationStore {
  const canvasId = sanitizeId(canvasIdInput, 'canvasId');
  const root = path.resolve(getWorkspacePath());
  let workspaceId: string | undefined;
  const operationRoot = safeJoin(root, '.huabu-operations', canvasId);
  const directory = path.relative(root, operationRoot);
  const redo = new DiskOperationRedo(root, directory, onStage);
  const scoped = (...segments: string[]) => {
    let target = operationRoot;
    for (const segment of segments)
      target = resolveDirectChildPath(target, segment);
    return path.relative(root, target);
  };
  const headPath = scoped('head.json');
  const guard = () => {
    const currentId = getWorkspaceHandle()?.workspaceId;
    if (!currentId) throw new Error('An active Workspace is required');
    workspaceId ??= currentId;
    if (path.resolve(getWorkspacePath()) !== root || currentId !== workspaceId)
      throw new Error('Disk operation belongs to an inactive Workspace');
    redo.recover();
  };
  const read = (relative: string): unknown | null => {
    const bytes = readOperationFile(root, relative);
    return bytes === null ? null : JSON.parse(bytes);
  };
  const head = () => {
    const raw = read(headPath);
    if (raw === null) return null;
    const value = diskOperationHeadSchema.parse(raw);
    if (value.workspaceId !== workspaceId || value.canvasId !== canvasId)
      throw new SpaceOperationError(
        'replay-corrupt',
        'Disk operation scope does not match its marker',
      );
    return value;
  };
  const statePath = () =>
    path.relative(
      root,
      resolveDirectChildPath(canvasRoot(canvasId), 'space.json'),
    );
  const sidecarPath = (filename: string) => {
    if (!filename.endsWith('.md'))
      throw new SpaceOperationError(
        'replay-corrupt',
        'Invalid managed sidecar filename',
      );
    return path.relative(
      root,
      resolveDirectChildPath(safeJoin(canvasRoot(canvasId), 'nodes'), filename),
    );
  };
  const reviewPath = (threadId: string) =>
    path.relative(
      root,
      resolveDirectChildPath(
        safeJoin(canvasRoot(canvasId), '.history', 'chat'),
        `${sanitizeId(threadId, 'threadId')}.changes.json`,
      ),
    );
  const snapshot = (): SpaceOperationSnapshot | null => {
    const marker = head();
    if (!marker) return null;
    const bytes = readOperationFile(root, statePath());
    if (bytes === null || diskBytesDigest(bytes) !== marker.recordDigest)
      throw new SpaceOperationError(
        'replay-corrupt',
        'Managed Space changed outside the operation authority',
      );
    const record = JSON.parse(bytes) as CanvasFile;
    const shapeError = canvasFileShapeError(record, canvasId);
    if (shapeError) throw new SpaceOperationError('replay-corrupt', shapeError);
    const sidecars: Record<string, NodeContent> = {};
    const names = new Set<string>();
    for (const [nodeId, file] of Object.entries(marker.sidecars)) {
      if (names.has(file.filename))
        throw new SpaceOperationError(
          'replay-corrupt',
          'Duplicate managed sidecar filename',
        );
      names.add(file.filename);
      const content = readOperationFile(root, sidecarPath(file.filename));
      if (content === null || diskBytesDigest(content) !== file.digest)
        throw new SpaceOperationError(
          'replay-corrupt',
          'Managed sidecar changed outside the operation authority',
        );
      sidecars[nodeId] = markdownToNodeContent(nodeId, content, true);
    }
    const reviews: Record<string, CanvasChangeRecord[]> = {};
    for (const [threadId, digest] of Object.entries(marker.reviews)) {
      const bytes = readOperationFile(root, reviewPath(threadId));
      if (bytes === null || diskBytesDigest(bytes) !== digest)
        throw new SpaceOperationError(
          'replay-corrupt',
          'Managed Review changed outside the operation authority',
        );
      const records: unknown = JSON.parse(bytes);
      if (!Array.isArray(records))
        throw new SpaceOperationError(
          'replay-corrupt',
          'Managed Review must be an array',
        );
      reviews[threadId] = coalesceChanges(records as CanvasChangeRecord[]);
    }
    return {
      record,
      metadata: marker.metadata,
      sidecars,
      reviews,
    };
  };
  const requireSnapshot = () => {
    const current = snapshot();
    if (!current)
      throw new SpaceOperationError(
        'collaboration-disabled',
        'This Space has no operation baseline',
      );
    return current;
  };
  const sessionPath = (key: SpaceOperationKey) =>
    scoped(key.spaceEpoch, key.sessionId, 'session.json');
  const receiptPath = (key: SpaceOperationKey) =>
    scoped(key.spaceEpoch, key.sessionId, `${key.operationId}.json`);
  const lease = (key: SpaceOperationKey) => {
    const raw = read(sessionPath(key));
    if (!raw) return null;
    const value = sessionSchema.parse(raw);
    if (value.principalId !== key.principalId)
      throw new SpaceOperationError(
        'session-forbidden',
        'The session belongs to a different authenticated scope',
      );
    if (
      value.session.spaceEpoch !== key.spaceEpoch ||
      value.session.sessionId !== key.sessionId
    )
      throw new SpaceOperationError(
        'replay-corrupt',
        'Stored session identity mismatch',
      );
    return value.session;
  };
  const lookup = (
    key: SpaceOperationKey,
    digest?: string,
  ): CanvasOperationLookup => {
    const session = lease(key);
    if (!session) return { status: 'expired' };
    const raw = read(receiptPath(key));
    if (raw !== null) {
      const stored = receiptSchema.parse(raw);
      const { receipt } = stored;
      if (
        receipt.spaceEpoch !== key.spaceEpoch ||
        receipt.sessionId !== key.sessionId ||
        receipt.operationId !== key.operationId
      )
        throw new SpaceOperationError(
          'replay-corrupt',
          'Stored receipt identity mismatch',
        );
      if (digest !== undefined && stored.digest !== digest)
        throw new SpaceOperationError(
          'operation-id-reused',
          'Operation ID was already used for a different request',
        );
      return { status: 'terminal', receipt };
    }
    if (
      session.expiresAt <= now() ||
      head()?.metadata.spaceEpoch !== key.spaceEpoch ||
      readOperationFile(root, statePath()) === null
    )
      return { status: 'expired' };
    return { status: 'absent' };
  };
  const projection = (
    relative: string,
    after: string | null,
  ): DiskOperationProjection => {
    const before = readOperationFile(root, relative);
    return {
      path: relative,
      before: before === null ? null : diskBytesDigest(before),
      after,
    };
  };
  const jsonProjection = (relative: string, value: unknown) =>
    projection(relative, stringifyJson(value, 'Disk operation'));

  return {
    async readSnapshot() {
      guard();
      return snapshot();
    },
    async createSession(principalId) {
      guard();
      assertSpaceMutationAllowed(root, canvasId);
      if (!principalId)
        throw new SpaceOperationError(
          'session-forbidden',
          'Authenticated scope is required',
        );
      const current = requireSnapshot();
      const session = newOperationSession(current.metadata.spaceEpoch, now());
      redo.commit([
        jsonProjection(
          sessionPath({ ...session, principalId, operationId: '' }),
          { principalId, session },
        ),
      ]);
      return session;
    },
    async lookup(key, digest) {
      guard();
      return lookup(key, digest);
    },
    async commit(input) {
      guard();
      assertSpaceMutationAllowed(root, canvasId);
      const prior = lookup(input.key, input.digest);
      if (prior.status === 'terminal') return prior.receipt;
      if (prior.status !== 'absent')
        throw new SpaceOperationError(
          'session-expired',
          'Operation session is unavailable or expired',
        );
      const current = requireSnapshot();
      validateOperationWrite(current, input);
      const marker = head();
      if (!marker)
        throw new SpaceOperationError(
          'replay-corrupt',
          'Missing Disk operation marker',
        );
      const projections: DiskOperationProjection[] = [];
      if (input.structure) {
        if (input.structure.delta)
          throw new SpaceOperationError(
            'invalid-commit',
            'New operations cannot append a legacy delta journal',
          );
        for (const mutation of input.structure.nodeMutations) {
          const file = marker.sidecars[mutation.nodeId];
          if (mutation.kind === 'delete') {
            if (!file)
              throw new SpaceOperationError(
                'invalid-commit',
                'Missing managed sidecar for deletion',
              );
            projections.push({
              path: sidecarPath(file.filename),
              before: file.digest,
              after: null,
            });
            delete marker.sidecars[mutation.nodeId];
            continue;
          }
          const nodesDirectory = safeJoin(canvasRoot(canvasId), 'nodes');
          const filename =
            file?.filename ??
            dedupeArtifactFilename(
              `${toSafeFilename(mutation.record.label, mutation.nodeId)}.md`,
              [
                ...Object.values(marker.sidecars).map(
                  ({ filename }) => filename,
                ),
                ...(existsSync(nodesDirectory)
                  ? readdirSync(nodesDirectory)
                  : []),
              ],
            );
          const bytes = nodeContentToMarkdown(mutation.record);
          const restored = markdownToNodeContent(mutation.nodeId, bytes, true);
          if (operationDigest(restored) !== operationDigest(mutation.record))
            throw new SpaceOperationError(
              'invalid-commit',
              'Sidecar codec would change the committed record',
            );
          projections.push({
            path: sidecarPath(filename),
            before: file?.digest ?? null,
            after: bytes,
          });
          marker.sidecars[mutation.nodeId] = {
            filename,
            digest: diskBytesDigest(bytes),
          };
        }
        const bytes = stringifyJson(input.structure.nextRecord, 'Space record');
        projections.push({
          path: statePath(),
          before: marker.recordDigest,
          after: bytes,
        });
        marker.recordDigest = diskBytesDigest(bytes);
      }
      for (const review of input.review) {
        const bytes = stringifyJson(review.records, 'Operation Review');
        projections.push({
          path: reviewPath(review.threadId),
          before: marker.reviews[review.threadId] ?? null,
          after: bytes,
        });
        marker.reviews[review.threadId] = diskBytesDigest(bytes);
      }
      if (input.receipt.status === 'committed') {
        projections.push(
          jsonProjection(
            scoped(
              input.key.spaceEpoch,
              'commits',
              `${input.receipt.commitVersion}.json`,
            ),
            input.receipt.commit,
          ),
        );
      }
      if (input.receipt.status === 'committed') {
        marker.metadata = input.metadata;
        projections.push(jsonProjection(headPath, marker));
      }
      projections.push(
        jsonProjection(receiptPath(input.key), {
          digest: input.digest,
          receipt: input.receipt,
        }),
      );
      redo.commit(projections);
      return input.receipt;
    },
    async readCommits(raw) {
      guard();
      const query = canvasCommitQuerySchema.parse(raw);
      const current = requireSnapshot();
      const through = query.throughVersion ?? current.record.version;
      const rows: unknown[] = [];
      if (
        query.spaceEpoch === current.metadata.spaceEpoch &&
        query.afterVersion >= current.metadata.earliestReplayVersion
      )
        for (
          let version = query.afterVersion + 1;
          version <= through && rows.length < query.limit;
          version++
        ) {
          const row = read(
            scoped(query.spaceEpoch, 'commits', `${version}.json`),
          );
          if (row === null) break;
          rows.push(row);
        }
      return operationReplayPage(current, query, rows);
    },
  };
}
