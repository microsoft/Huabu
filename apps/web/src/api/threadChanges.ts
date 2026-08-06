// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  DeleteThreadChangeResponse,
  GetThreadChangesResponse,
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
