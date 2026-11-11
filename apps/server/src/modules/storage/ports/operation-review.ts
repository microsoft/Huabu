// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  diffCanvasState,
  extractCanvasChanges,
} from '@huabu/shared/canvas-engine';

import { SpaceOperationError } from './operations.js';
import { digestJson } from '../../../utils/json.js';

import type {
  SpaceOperationSnapshot,
  SpaceOperationWrite,
} from './operations.js';
import type { CanvasOperationCommit } from '@huabu/shared';

type DiffState = Parameters<typeof diffCanvasState>[0];

/** New records only: legacy coalescing cannot establish field-writer provenance. */
export function projectFieldReview(
  snapshot: SpaceOperationSnapshot,
  state: SpaceOperationSnapshot['record']['state'],
  commit: CanvasOperationCommit,
  threadId: string,
) {
  if (
    !/^[a-zA-Z0-9_-]{1,256}$/.test(threadId) ||
    commit.origin.kind !== 'agent' ||
    commit.events.some((event) => event.type !== 'PATCH_NODE' || !event.context)
  )
    throw new SpaceOperationError(
      'invalid-commit',
      'Review recording requires a trusted field-only Agent commit',
    );
  const records = extractCanvasChanges(
    diffCanvasState(snapshot.record.state as DiffState, state as DiffState),
  ).map((record, index) => ({
    ...record,
    id: `change-${commit.sessionId}-${commit.operationId}-${index}`,
  }));
  const existing = snapshot.reviews[threadId] ?? [];
  if (
    !records.length ||
    records.length > 50 ||
    records.some((record) =>
      existing.some(
        (old) => old.id === record.id || old.nodeId === record.nodeId,
      ),
    )
  )
    throw new SpaceOperationError(
      'invalid-commit',
      'Existing Review targets require a coalesced provenance adapter',
    );
  return {
    descriptor: {
      threadId,
      changeIds: records.map(({ id }) => id),
      recordsDigest: digestJson(records),
    },
    review: [{ threadId, records: [...existing, ...records] }],
  };
}

export function attachFieldReview(
  snapshot: SpaceOperationSnapshot,
  plan: SpaceOperationWrite,
  threadId: string,
): SpaceOperationWrite {
  if (plan.receipt.status !== 'committed' || !plan.structure) return plan;
  const projected = projectFieldReview(
    snapshot,
    plan.structure.nextRecord.state,
    plan.receipt.commit,
    threadId,
  );
  const reviewRevision = snapshot.metadata.reviewRevision + 1;
  return {
    ...plan,
    metadata: { ...plan.metadata, reviewRevision },
    review: projected.review,
    receipt: {
      ...plan.receipt,
      commit: {
        ...plan.receipt.commit,
        reviewRecord: projected.descriptor,
        reviewRevision,
      },
    },
  };
}
