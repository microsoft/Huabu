// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-node preprocessing queue.
 *
 * Each node mutation schedules a debounced
 * {@link preprocessNodeIfNeeded} call so rapid edits collapse into a
 * single POST `/api/canvas/:id/nodes/:nodeId/preprocess`. Fire-and-
 * forget — preprocessing results are written back into the store via
 * `setNodeIngestion` / `clearNodeIngestion` / `patchNodeSilent` on
 * the dependencies object.
 *
 * Unlike {@link ../save/nodeContentQueue} this queue does NOT serialize
 * per-node requests. Label projection re-checks the latest node ownership
 * before applying a response so stale auto labels cannot replace user/agent
 * names. Other derived metadata remains last-response-wins within a canvas
 * projection generation; cancellation invalidates older projections.
 *
 * The keepalive path used at page unload bypasses
 * `preprocessNodeIfNeeded` (which mutates ingestion state that won't
 * render anyway) and fires `preprocessNode` directly with a
 * server-recognized `trigger: 'flush'` snapshot.
 */

import { preprocessNode } from '@/api';
import {
  buildPreprocessSnapshot,
  preprocessNodeIfNeeded,
  type NodeIngestionInfo,
} from '@/handler/canvasCommand/preprocess';

import { createPerKeyDebouncer } from './perKeyDebouncer';

import type { CanvasNodeType } from '@huabu/shared';
import type { Node } from '@xyflow/react';

function isExcludedFromPreprocessing(node: Node): boolean {
  // Sketch has no preprocessable payload; Space Preview is view-only.
  // Keep this boundary zod-free rather than duplicating server profiles.
  return (
    node.type === ('sketch' satisfies CanvasNodeType) ||
    node.type === ('spacePreview' satisfies CanvasNodeType)
  );
}

function hasMissingContent(node: Node): boolean {
  return node.data?.contentMissing === true;
}

/**
 * Slice fields the queue reads at fire time. Kept structural (not
 * `RFState`) so this module is free of store-type coupling and
 * import cycles.
 */
export type PreprocessQueueState = {
  canvasId: string;
  nodes: readonly Node[];
  setNodeIngestion: (nodeId: string, info: NodeIngestionInfo) => void;
  clearNodeIngestion: (nodeId: string) => void;
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
};

/**
 * Public shape returned by {@link createPreprocessQueue}.
 */
export type PreprocessQueue = {
  waitForIdle(): Promise<void>;
  /**
   * Schedule (or reschedule) a debounced preprocess for `node`. The
   * latest store state is re-read at fire time so trailing edits
   * are reflected in the snapshot sent to the server.
   */
  schedule(node: Node): void;

  /**
   * Cancel every pending preprocess timer without firing and invalidate
   * in-flight projections. Used by canvas switches and history restores.
   * Issued requests remain completion-tracked for DELETE ordering.
   */
  cancelAll(): void;

  /**
   * For every node with a pending debounce, cancel its timer and
   * fire a keepalive POST against the server with a fresh snapshot.
   * Used by the `beforeunload` listener so AI label / summary work
   * the user just triggered isn't lost on close.
   *
   * No-op when no canvasId is loaded.
   */
  flushKeepalive(): void;
};

/**
 * Build a {@link PreprocessQueue}.
 *
 * @param opts.delayMs - debounce delay
 * @param opts.getState - lazy getter for the store slice fields the
 *   queue needs. Re-invoked on every fire so HMR / store swaps Just
 *   Work.
 */
export function createPreprocessQueue(opts: {
  delayMs: number;
  getState: () => PreprocessQueueState;
  isBlocked?: (nodeId: string) => boolean;
}): PreprocessQueue {
  const debouncer = createPerKeyDebouncer<string>(opts.delayMs);
  const inflight = new Set<Promise<void>>();
  let projectionGeneration = 0;

  return {
    async waitForIdle() {
      await Promise.all(inflight);
    },

    schedule(node) {
      if (isExcludedFromPreprocessing(node)) return;
      if (hasMissingContent(node)) return;
      if (opts.isBlocked?.(node.id)) return;
      const scheduledState = opts.getState();
      if (!scheduledState.canvasId) return;
      const nodeId = node.id;
      scheduledState.setNodeIngestion(nodeId, {
        status: 'pending',
        updatedAt: Date.now(),
      });
      debouncer.schedule(nodeId, () => {
        const state = opts.getState();
        if (!state.canvasId || state.canvasId !== scheduledState.canvasId)
          return;
        // Re-fetch the latest node so we send the most up-to-date content.
        const latestNode = state.nodes.find((n) => n.id === nodeId);
        if (!latestNode || opts.isBlocked?.(nodeId)) return;
        if (isExcludedFromPreprocessing(latestNode)) {
          state.clearNodeIngestion(nodeId);
          return;
        }
        if (hasMissingContent(latestNode)) return;
        const generation = projectionGeneration;
        const pending = preprocessNodeIfNeeded({
          canvasId: state.canvasId,
          node: latestNode,
          setNodeIngestion: state.setNodeIngestion,
          clearNodeIngestion: state.clearNodeIngestion,
          getChildNodes: (frameId) =>
            state.nodes.filter((n) => n.parentId === frameId),
          getNode: (id) =>
            opts.getState().nodes.find((candidate) => candidate.id === id),
          patchNodeSilent: (id, patch) => {
            if (
              generation === projectionGeneration &&
              opts.getState().canvasId === state.canvasId &&
              opts.getState().nodes.some((node) => node.id === id) &&
              !opts.isBlocked?.(id)
            ) {
              state.patchNodeSilent(id, patch);
            }
          },
        });
        inflight.add(pending);
        void pending.finally(() => inflight.delete(pending));
      });
    },

    cancelAll() {
      debouncer.cancelAll();
      projectionGeneration++;
    },

    flushKeepalive() {
      const pendingIds = debouncer.cancelAll();
      if (pendingIds.length === 0) return;

      const state = opts.getState();
      const { canvasId, nodes } = state;
      if (!canvasId) return;

      for (const nodeId of pendingIds) {
        const node = nodes.find((n) => n.id === nodeId);
        if (
          !node ||
          opts.isBlocked?.(nodeId) ||
          isExcludedFromPreprocessing(node) ||
          hasMissingContent(node)
        )
          continue;
        const snapshot = buildPreprocessSnapshot(node, (frameId) =>
          nodes.filter((n) => n.parentId === frameId),
        );
        void preprocessNode(
          canvasId,
          nodeId,
          { nodeType: node.type ?? '', trigger: 'flush', snapshot },
          { keepalive: true },
        ).catch(() => undefined);
      }
    },
  };
}
