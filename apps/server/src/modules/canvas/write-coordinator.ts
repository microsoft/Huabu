// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas-domain serialization for standalone node writes.
 *
 * The mutex is application policy, not a storage-backend guarantee. It keeps
 * this process's content PUT and preprocessing writers ordered with executor
 * batches while the backend-neutral repository supplies the actual read/CAS
 * persistence operations.
 */

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import type {
  NodeContent,
  NodePutResult,
  SpaceNodes,
} from '../storage/index.js';

const canvasMutexChains = new Map<string, Promise<unknown>>();

export async function withCanvasMutex<T>(
  canvasId: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = canvasMutexChains.get(canvasId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  canvasMutexChains.set(canvasId, next);
  try {
    return await next;
  } finally {
    if (canvasMutexChains.get(canvasId) === next) {
      canvasMutexChains.delete(canvasId);
    }
  }
}

type NodeRejection = Exclude<
  Extract<NodePutResult, { ok: false }>,
  { reason: 'revision-conflict' | 'write-suppressed' }
>;

export type UpdateNodeOutcome =
  | { status: 'ok'; rev: string; label: string | null }
  | { status: 'rev-conflict'; currentRev: string }
  | { status: 'noop' }
  | { status: 'skipped-deleted' }
  | { status: 'rejected'; result: NodeRejection };

export interface UpdateNodeOptions {
  /** Optimistic-concurrency baseline for authored content. */
  expectRev?: string;
  /**
   * Return a complete replacement record, or null for no write.
   *
   * A full-record CAS conflict may cause this callback to run again with a
   * fresher snapshot. It may update local result bookkeeping, but must not
   * perform external side effects.
   */
  apply: (current: NodeContent | null) => NodeContent | null;
  /** Reject a user-requested logical-name collision instead of de-duplicating. */
  strictRename?: boolean;
}

function contentRevisionOf(record: NodeContent | null): string {
  return nodeRevisionOf({
    ...(typeof record?.content === 'string' ? { content: record.content } : {}),
    ...(typeof record?.src === 'string' ? { src: record.src } : {}),
  });
}

/**
 * Serialize read → decide → CAS-write for one node in this process.
 *
 * Repository calls may be asynchronous; the mutex remains held across them.
 * Cross-process ordering and transaction strength belong to the adapter and
 * are intentionally not claimed here.
 */
export async function updateNode(
  nodes: SpaceNodes,
  nodeId: string,
  opts: UpdateNodeOptions,
): Promise<UpdateNodeOutcome> {
  return withCanvasMutex(nodes.canvasId, async () => {
    // Public Canvas revisions cover content + src. Repository revisions are
    // opaque full-record tokens. Keep the two distinct so an async SQL
    // adapter cannot lose a concurrent label/metadata edit during RMW.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await nodes.read(nodeId);
      const currentContentRevision = contentRevisionOf(current?.record ?? null);

      if (
        opts.expectRev !== undefined &&
        opts.expectRev !== currentContentRevision
      ) {
        return {
          status: 'rev-conflict',
          currentRev: currentContentRevision,
        };
      }

      const next = opts.apply(current?.record ?? null);
      if (next === null) return { status: 'noop' };

      const result = await nodes.put({
        nodeId,
        record: next,
        expectedRevision: current?.revision ?? null,
        ...(opts.strictRename !== undefined
          ? { strictLabel: opts.strictRename }
          : {}),
      });
      if (result.ok) {
        return {
          status: 'ok',
          rev: contentRevisionOf(result.record),
          label: result.record.label,
        };
      }
      if (result.reason === 'revision-conflict') {
        // A metadata-only change can be merged by re-running the caller's
        // pure apply function. A public content change is caught above on
        // the next iteration.
        continue;
      }
      if (result.reason === 'write-suppressed') {
        return { status: 'skipped-deleted' };
      }
      return { status: 'rejected', result };
    }

    const latest = await nodes.read(nodeId);
    return {
      status: 'rev-conflict',
      currentRev: contentRevisionOf(latest?.record ?? null),
    };
  });
}
