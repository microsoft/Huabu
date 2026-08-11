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
 * names. Other derived metadata remains last-response-wins.
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

import type {
  CanvasNodeType,
  ExecuteOriginator,
  PreprocessNodeResponse,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

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
  /** Ordered global Space cursor used to reject stale non-commit results. */
  version?: number;
  nodes: readonly Node[];
  setNodeIngestion: (nodeId: string, info: NodeIngestionInfo) => void;
  clearNodeIngestion: (nodeId: string) => void;
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
};

/**
 * Public shape returned by {@link createPreprocessQueue}.
 */
export type PreprocessQueue = {
  /**
   * Schedule (or reschedule) a debounced preprocess for `node`. The
   * latest store state is re-read at fire time so trailing edits
   * are reflected in the snapshot sent to the server.
   */
  schedule(node: Node): void;

  /** Release a create-time preprocess held until aggregate persistence. */
  releaseDeferred(nodeId: string): void;

  /** Cancel all pending/held work for a node that was deleted. */
  forgetNode(nodeId: string): void;

  /**
   * Cancel every pending preprocess timer without firing. Used by
   * `switchCanvas` to discard pending work for the outgoing canvas.
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
  /** Hold preprocessing while a new node has no committed topology yet. */
  shouldDeferNode?: (nodeId: string) => boolean;
  originator?: ExecuteOriginator;
  onMutationResponse?: (
    canvasId: string,
    response: PreprocessNodeResponse,
  ) => void;
}): PreprocessQueue {
  const debouncer = createPerKeyDebouncer<string>(opts.delayMs);
  const deferred = new Set<string>();

  function schedule(node: Node): void {
    // `sketch` is the only canvas node type excluded from the
    // server's preprocess pipeline (no preprocessable payload —
    // mirrors `preprocessableNodeTypeSchema` in packages/shared).
    // Gating it here avoids 400s from zod validation polluting
    // the network log. `satisfies` gives us a compile-time guard
    // against typos without dragging a runtime list into the
    // web bundle.
    if (node.type === ('sketch' satisfies CanvasNodeType)) return;
    if (hasMissingContent(node)) return;
    const scheduledState = opts.getState();
    if (!scheduledState.canvasId) return;
    const nodeId = node.id;
    scheduledState.setNodeIngestion(nodeId, {
      status: 'pending',
      updatedAt: Date.now(),
    });

    if (opts.shouldDeferNode?.(nodeId)) {
      // Topology and initial sidecar are not durable yet. Remember the
      // intent but do not let the debounce race the aggregate create.
      debouncer.cancel(nodeId);
      deferred.add(nodeId);
      return;
    }
    deferred.delete(nodeId);
    debouncer.schedule(nodeId, () => {
      const state = opts.getState();
      if (!state.canvasId) return;
      // Re-fetch the latest node so we send the most up-to-date content.
      const latestNode = state.nodes.find((n) => n.id === nodeId) ?? node;
      if (hasMissingContent(latestNode)) return;
      void preprocessNodeIfNeeded({
        canvasId: state.canvasId,
        node: latestNode,
        setNodeIngestion: state.setNodeIngestion,
        clearNodeIngestion: state.clearNodeIngestion,
        getChildNodes: (frameId) =>
          state.nodes.filter((n) => n.parentId === frameId),
        getNode: (id) =>
          opts.getState().nodes.find((candidate) => candidate.id === id),
        getVersion: () => opts.getState().version,
        patchNodeSilent: state.patchNodeSilent,
        originator: opts.originator,
        onMutationResponse: opts.onMutationResponse,
      });
    });
  }

  return {
    schedule,

    releaseDeferred(nodeId) {
      if (!deferred.delete(nodeId)) return;
      const node = opts
        .getState()
        .nodes.find((candidate) => candidate.id === nodeId);
      if (node) schedule(node);
    },

    forgetNode(nodeId) {
      deferred.delete(nodeId);
      debouncer.cancel(nodeId);
      opts.getState().clearNodeIngestion(nodeId);
    },

    cancelAll() {
      debouncer.cancelAll();
      deferred.clear();
    },

    flushKeepalive() {
      const pendingIds = debouncer.cancelAll();
      if (pendingIds.length === 0) return;

      const state = opts.getState();
      const { canvasId, nodes } = state;
      if (!canvasId) return;

      for (const nodeId of pendingIds) {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node || hasMissingContent(node)) continue;
        const snapshot = buildPreprocessSnapshot(node, (frameId) =>
          nodes.filter((n) => n.parentId === frameId),
        );
        void preprocessNode(
          canvasId,
          nodeId,
          {
            nodeType: node.type ?? '',
            trigger: 'flush',
            snapshot,
            ...(opts.originator ? { originator: opts.originator } : {}),
          },
          { keepalive: true },
        ).catch(() => undefined);
      }
    },
  };
}
