// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { space } from '../../storage/index.js';
import { SpaceOperationError } from '../../storage/ports/operations.js';
import { acquireWorkspaceOperationLease } from '../../workspace.js';
import { publishCanvasUpdate } from '../canvas-sync.js';
import { withCanvasMutex } from '../write-coordinator.js';

import type { SpaceOperationStore } from '../../storage/ports/operations.js';
import type { CanvasOperationReceipt } from '@huabu/shared';

export function operationChannel(
  workspaceKey: string,
  canvasId: string,
): string {
  return JSON.stringify(['operations', workspaceKey, canvasId]);
}

let operationsEnabledOverride: boolean | undefined;

/**
 * One process-wide development switch for the operation routes. It is off
 * unless `HUABU_CANVAS_OPERATIONS=1`; there is no per-Space activation.
 */
export function canvasOperationsEnabled(): boolean {
  return (
    operationsEnabledOverride ?? process.env.HUABU_CANVAS_OPERATIONS === '1'
  );
}

/** Test seam: force the switch, or pass `undefined` to follow the environment. */
export function setCanvasOperationsEnabled(enabled: boolean | undefined): void {
  operationsEnabledOverride = enabled;
}

export async function withCanvasOperations<T>(
  canvasId: string,
  action: (operations: SpaceOperationStore, channel: string) => Promise<T>,
): Promise<T> {
  const lease = acquireWorkspaceOperationLease();
  try {
    if (!canvasOperationsEnabled())
      throw new SpaceOperationError(
        'collaboration-disabled',
        'Canvas operations are disabled on this server',
      );
    const operations = space(canvasId).operations;
    if (!operations)
      throw new SpaceOperationError(
        'collaboration-disabled',
        'This backend has no operation adapter',
      );
    const channel = operationChannel(lease.workspaceKey, canvasId);
    return await withCanvasMutex(canvasId, () => action(operations, channel));
  } finally {
    lease.release();
  }
}

export function publishOperationReceipt(
  channel: string,
  receipt: CanvasOperationReceipt,
): void {
  if (receipt.status === 'committed')
    publishCanvasUpdate(channel, { type: 'commit', data: receipt.commit });
}
