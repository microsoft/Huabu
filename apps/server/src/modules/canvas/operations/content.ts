// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { canvasContentOperationRequestSchema } from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { resolveNodeContentUpdate } from '../node-content-update.js';
import { resolveOperationAlreadyLocked } from './admission.js';
import { operationNodes } from './candidate.js';
import { publishOperationReceipt } from './scope.js';
import { withCanvasOperations } from './scope.js';
import { getProfile } from '../../preprocessing/profiles.js';
import { operationDigest } from '../../storage/ports/operation-rules.js';
import { SpaceOperationError } from '../../storage/ports/operations.js';

import type {
  SpaceOperationSnapshot,
  SpaceOperationStore,
  SpaceOperationWrite,
} from '../../storage/ports/operations.js';
import type {
  CanvasContentOperationRequest,
  CanvasOperationCommit,
  CanvasOperationReceipt,
} from '@huabu/shared';

function prepareContentOperation(
  snapshot: SpaceOperationSnapshot,
  nodeId: string,
  request: CanvasContentOperationRequest,
  principalId: string,
  origin: CanvasOperationCommit['origin'],
  now: number,
): SpaceOperationWrite {
  if (request.spaceEpoch !== snapshot.metadata.spaceEpoch)
    throw new SpaceOperationError('stale-epoch', 'The Space epoch changed');
  if (request.observedVersion > snapshot.record.version)
    throw new SpaceOperationError(
      'head-conflict',
      'Observed version is ahead of the Space',
    );
  const node = operationNodes(snapshot).find((node) => node.id === nodeId);
  const meta = snapshot.metadata.nodes[nodeId];
  const existing = snapshot.sidecars[nodeId];
  const identity = {
    spaceEpoch: request.spaceEpoch,
    sessionId: request.sessionId,
    operationId: request.operationId,
  };
  const common = {
    key: { ...identity, principalId },
    digest: operationDigest({ nodeId, request }),
    expectedVersion: snapshot.record.version,
    metadata: structuredClone(snapshot.metadata),
    review: [],
  };
  const terminal = (
    reason:
      | 'stale-target'
      | 'locked'
      | 'unsupported-command'
      | 'content-conflict'
      | 'no-change',
    contentRevision?: string,
  ): SpaceOperationWrite => ({
    ...common,
    receipt: {
      ...identity,
      status: reason === 'no-change' ? 'noop' : 'rejected',
      atVersion: snapshot.record.version,
      commit: null,
      results: [
        {
          commandIndex: 0,
          nodeId,
          applied: false,
          reason,
          ...(contentRevision !== undefined ? { contentRevision } : {}),
        },
      ],
    },
  });
  if (
    !node ||
    !meta ||
    meta.incarnation !== request.incarnation ||
    !existing ||
    existing.nodeId !== nodeId ||
    existing.type !== node.type ||
    request.update.nodeType !== node.type
  )
    return terminal('stale-target');
  if (node.data['locked'] === true) return terminal('locked');
  if (
    node.parentId ||
    getProfile(request.update.nodeType)?.bodyOwnership !== 'authored'
  )
    return terminal('unsupported-command');
  const beforeRevision = nodeRevisionOf(existing);
  if (beforeRevision !== request.update.expectRev)
    return terminal('content-conflict', beforeRevision);
  const next = resolveNodeContentUpdate(nodeId, request.update, existing);
  if (operationDigest(existing) === operationDigest(next))
    return terminal('no-change', beforeRevision);
  const afterRevision = nodeRevisionOf(next);
  const toVersion = snapshot.record.version + 1;
  const results = [
    {
      commandIndex: 0,
      nodeId,
      applied: true,
      contentRevision: afterRevision,
    },
  ];
  const commit: CanvasOperationCommit = {
    ...identity,
    fromVersion: snapshot.record.version,
    toVersion,
    origin,
    results,
    events: [
      {
        type: 'NODE_CONTENT_REVISION',
        nodeId,
        incarnation: meta.incarnation,
        beforeRevision,
        afterRevision,
      },
    ],
  };
  return {
    ...common,
    receipt: {
      ...identity,
      status: 'committed',
      commitVersion: toVersion,
      commit,
      results,
    },
    structure: {
      expectedVersion: snapshot.record.version,
      nextRecord: { ...snapshot.record, version: toVersion, updatedAt: now },
      nodeMutations: [{ kind: 'put', nodeId, record: next }],
    },
  };
}

/** Reuse the same receipt-first boundary as structural commands. */
export async function submitContentOperationAlreadyLocked(
  operations: SpaceOperationStore,
  nodeId: string,
  raw: unknown,
  principalId: string,
  origin: CanvasOperationCommit['origin'],
  now: number,
): Promise<CanvasOperationReceipt> {
  const parsed = canvasContentOperationRequestSchema.safeParse(raw);
  if (!parsed.success)
    throw new SpaceOperationError(
      'invalid-commit',
      'Invalid content operation',
    );
  const request = parsed.data;
  return resolveOperationAlreadyLocked(
    operations,
    {
      spaceEpoch: request.spaceEpoch,
      sessionId: request.sessionId,
      operationId: request.operationId,
      principalId,
    },
    operationDigest({ nodeId, request }),
    (snapshot) =>
      prepareContentOperation(
        snapshot,
        nodeId,
        request,
        principalId,
        origin,
        now,
      ),
  );
}

export async function submitCanvasContentOperation(input: {
  canvasId: string;
  nodeId: string;
  request: unknown;
  principalId: string;
  origin: CanvasOperationCommit['origin'];
}): Promise<CanvasOperationReceipt> {
  return withCanvasOperations(input.canvasId, async (operations, channel) => {
    const receipt = await submitContentOperationAlreadyLocked(
      operations,
      input.nodeId,
      input.request,
      input.principalId,
      input.origin,
      Date.now(),
    );
    publishOperationReceipt(channel, receipt);
    return receipt;
  });
}
