// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  DeleteThreadChangeResponse,
  GetThreadChangesResponse,
  QuerySpaceChangesResponse,
  SeenChange,
  SeenChanges,
  SeenChangesResponse,
} from '@huabu/shared';
import type { CanvasChangeRecord } from '@huabu/shared/canvas-engine';

/** Load the pending change-review records for an ACP thread. */
export async function getThreadChanges(
  canvasId: string,
  threadId: string,
): Promise<CanvasChangeRecord[]> {
  const res = await apiFetch<GetThreadChangesResponse>(
    routes.canvasThreadChanges(canvasId, threadId),
  );
  return res.changes;
}

/**
 * Load the pending change-review records of several threads at once, with
 * what the person has seen of them.
 */
export async function querySpaceChanges(
  canvasId: string,
  threadIds: readonly string[],
): Promise<QuerySpaceChangesResponse> {
  return apiFetch<QuerySpaceChangesResponse>(
    routes.canvasChangesQuery(canvasId),
    { method: 'POST', json: { threadIds } },
  );
}

/** Everything the person has seen of the Space's changes. */
export async function getSeenChanges(canvasId: string): Promise<SeenChanges> {
  const res = await apiFetch<SeenChangesResponse>(
    routes.canvasChangesSeen(canvasId),
  );
  return res.seen;
}

/** Record cells as seen by the person; resolves to all they have seen. */
export async function markSeenChanges(
  canvasId: string,
  seen: readonly SeenChange[],
): Promise<SeenChanges> {
  const res = await apiFetch<SeenChangesResponse>(
    routes.canvasChangesSeen(canvasId),
    { method: 'POST', json: { seen } },
  );
  return res.seen;
}

/** Accept (discard) a single change record. */
export async function acceptThreadChange(
  canvasId: string,
  threadId: string,
  changeId: string,
): Promise<DeleteThreadChangeResponse> {
  return apiFetch<DeleteThreadChangeResponse>(
    routes.canvasThreadChange(canvasId, threadId, changeId),
    { method: 'DELETE' },
  );
}

/** Revert a single change (applies inverse deltas server-side) + discards it. */
export async function revertThreadChange(
  canvasId: string,
  threadId: string,
  changeId: string,
): Promise<DeleteThreadChangeResponse> {
  return apiFetch<DeleteThreadChangeResponse>(
    routes.canvasThreadChangeRevert(canvasId, threadId, changeId),
    { method: 'POST' },
  );
}
