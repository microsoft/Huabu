// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Application-level serialization for one Space mutation workflow.
 *
 * The Disk committer has its own backend-local admission gate for durability,
 * while this mutex keeps higher-level read/derive/commit sequences from
 * interleaving inside one server process.
 */

import { withWorkspaceOperationLease } from '../workspace.js';

const canvasMutexChains = new Map<string, Promise<unknown>>();

export async function withCanvasMutex<T>(
  canvasId: string,
  task: () => Promise<T>,
): Promise<T> {
  return withWorkspaceOperationLease(async (workspacePath) => {
    // Include the Workspace in the key defensively. The lease prevents a
    // switch while this task is queued or running; the qualified key also
    // makes that ownership explicit and avoids cross-Workspace chains in
    // tests that activate several roots in one process.
    const key = `${workspacePath}\u0000${canvasId}`;
    const previous = canvasMutexChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    canvasMutexChains.set(key, next);
    try {
      return await next;
    } finally {
      if (canvasMutexChains.get(key) === next) {
        canvasMutexChains.delete(key);
      }
    }
  });
}
