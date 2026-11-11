// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { canvasOperationRequestSchema } from '@huabu/shared';

import { resolveOperationAlreadyLocked } from './admission.js';
import { prepareOperationCandidate } from './candidate.js';
import { publishOperationReceipt, withCanvasOperations } from './scope.js';
import { getAgentChangeReviewConfig } from '../../agent/change-review-config.js';
import { attachFieldReview } from '../../storage/ports/operation-review.js';
import { operationDigest } from '../../storage/ports/operation-rules.js';
import { SpaceOperationError } from '../../storage/ports/operations.js';

import type { SpaceOperationStore } from '../../storage/ports/operations.js';
import type {
  CanvasOperationCommit,
  CanvasOperationReceipt,
} from '@huabu/shared';

/**
 * Internal admission primitive. The caller owns the captured Workspace lease
 * and Space mutex, including every operation lookup. No external preparation is
 * permitted in the common root-node position/accent/order allowlist.
 */
export async function submitOperationAlreadyLocked(
  operations: SpaceOperationStore,
  raw: unknown,
  principalId: string,
  origin: CanvasOperationCommit['origin'],
  now: number,
  reviewThreadId?: string,
): Promise<CanvasOperationReceipt> {
  const parsed = canvasOperationRequestSchema.safeParse(raw);
  if (!parsed.success)
    throw new SpaceOperationError(
      'invalid-commit',
      'Invalid operation request',
    );
  const request = parsed.data;
  const key = {
    principalId,
    spaceEpoch: request.spaceEpoch,
    sessionId: request.sessionId,
    operationId: request.operationId,
  };
  const digest = operationDigest(
    reviewThreadId === undefined ? request : { request, reviewThreadId },
  );
  return resolveOperationAlreadyLocked(operations, key, digest, (snapshot) => {
    const plan = {
      ...prepareOperationCandidate(snapshot, request, principalId, origin, now),
      digest,
    };
    if (reviewThreadId === undefined) return plan;
    if (origin.kind !== 'agent')
      throw new SpaceOperationError(
        'invalid-commit',
        'Review attribution requires an Agent owner',
      );
    return getAgentChangeReviewConfig().autoAcceptSpaceChanges
      ? plan
      : attachFieldReview(snapshot, plan, reviewThreadId);
  });
}

export async function submitCanvasOperation(input: {
  canvasId: string;
  request: unknown;
  principalId: string;
  origin: CanvasOperationCommit['origin'];
  /** Trusted owner attribution, never copied from an HTTP operation body. */
  reviewThreadId?: string;
}): Promise<CanvasOperationReceipt> {
  return withCanvasOperations(input.canvasId, async (operations, channel) => {
    const receipt = await submitOperationAlreadyLocked(
      operations,
      input.request,
      input.principalId,
      input.origin,
      Date.now(),
      input.reviewThreadId,
    );
    publishOperationReceipt(channel, receipt);
    return receipt;
  });
}
