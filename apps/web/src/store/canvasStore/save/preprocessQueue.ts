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
 * Unlike {@link ../save/nodeContentQueue} this queue does NOT need
 * per-node inflight serialization: preprocessing is idempotent (the
 * server recomputes the same label/summary/keywords given the same
 * snapshot), so a race between two POSTs only wastes a request — it
 * cannot corrupt state.
 *
 * The keepalive path used at page unload bypasses
 * `preprocessNodeIfNeeded` (which mutates ingestion state that won't
 * render anyway) and fires `preprocessNode` directly with a
 * server-recognized `trigger: 'flush'` snapshot.
 */

import { PREPROCESSABLE_NODE_TYPES } from '@sediment/shared';

import { preprocessNode } from '@/api';
import {
  buildPreprocessSnapshot,
  preprocessNodeIfNeeded,
  type NodeIngestionInfo,
} from '@/handler/canvasCommand/preprocess';

import { createPerKeyDebouncer } from './perKeyDebouncer';

import type { Node } from '@xyflow/react';

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
  /**
   * Schedule (or reschedule) a debounced preprocess for `node`. The
   * latest store state is re-read at fire time so trailing edits
   * are reflected in the snapshot sent to the server.
   */
  schedule(node: Node): void;

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
}): PreprocessQueue {
  const debouncer = createPerKeyDebouncer<string>(opts.delayMs);

  return {
    schedule(node) {
      // Skip node types the server explicitly excludes from the
      // preprocess pipeline (e.g. `sketch` — no preprocessable
      // payload). Without this gate every sketch mutation would
      // POST a request that the server rejects at zod validation
      // with `400 Bad Request`, polluting the network log.
      const nodeType = typeof node.type === 'string' ? node.type : '';
      if (!PREPROCESSABLE_NODE_TYPES.has(nodeType)) return;
      const nodeId = node.id;
      debouncer.schedule(nodeId, () => {
        const state = opts.getState();
        if (!state.canvasId) return;
        // Re-fetch the latest node so we send the most up-to-date content.
        const latestNode = state.nodes.find((n) => n.id === nodeId) ?? node;
        void preprocessNodeIfNeeded({
          canvasId: state.canvasId,
          node: latestNode,
          setNodeIngestion: state.setNodeIngestion,
          clearNodeIngestion: state.clearNodeIngestion,
          getChildNodes: (frameId) =>
            state.nodes.filter((n) => n.parentId === frameId),
          patchNodeSilent: state.patchNodeSilent,
        });
      });
    },

    cancelAll() {
      debouncer.cancelAll();
    },

    flushKeepalive() {
      const pendingIds = debouncer.cancelAll();
      if (pendingIds.length === 0) return;

      const state = opts.getState();
      const { canvasId, nodes } = state;
      if (!canvasId) return;

      for (const nodeId of pendingIds) {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) continue;
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
