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
 * names. Each scheduled task owns its projections and ingestion status;
 * superseded tasks remain tracked for DELETE ordering, but cannot update UI.
 *
 * The keepalive path used at page unload bypasses
 * `preprocessNodeIfNeeded` (which mutates ingestion state that won't
 * render anyway) and fires `preprocessNode` directly with a
 * server-recognized `trigger: 'flush'` snapshot.
 */

import deepEqual from 'fast-deep-equal';

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
  /** Retain unfinished work for a possible history resurrection. */
  forgetNode(nodeId: string): void;
  /** Reconcile only tasks whose request inputs changed in history. */
  reconcileHistory(previousNodes: readonly Node[]): void;
  /** Resume interrupted work after the restored sidecar has committed. */
  resumeRestored(canvasId: string, nodeId: string): void;
  /**
   * Schedule (or reschedule) a debounced preprocess for `node`. The
   * latest store state is re-read at fire time so trailing edits
   * are reflected in the snapshot sent to the server.
   */
  schedule(node: Node): void;

  /**
   * Cancel every pending preprocess timer without firing and invalidate
   * in-flight projections. Used by canvas switches, not history restores.
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
  const tasks = new Map<string, { canvasId: string }>();
  const interrupted = new Map<string, Set<string>>();

  function invalidate(nodeId: string): void {
    const task = tasks.get(nodeId);
    tasks.delete(nodeId);
    debouncer.cancel(nodeId);
    if (task?.canvasId === opts.getState().canvasId) {
      opts.getState().clearNodeIngestion(nodeId);
    }
  }

  function requestInput(node: Node, nodes: readonly Node[]) {
    return {
      nodeType: node.type,
      snapshot: buildPreprocessSnapshot(node, (id) =>
        nodes.filter((child) => child.parentId === id),
      ),
    };
  }

  const queue: PreprocessQueue = {
    async waitForIdle() {
      await Promise.all(inflight);
    },

    forgetNode(nodeId) {
      const task = tasks.get(nodeId);
      if (task) {
        const ids = interrupted.get(task.canvasId) ?? new Set<string>();
        ids.add(nodeId);
        interrupted.set(task.canvasId, ids);
      }
      invalidate(nodeId);
    },

    reconcileHistory(previousNodes) {
      const state = opts.getState();
      const previous = new Map(previousNodes.map((node) => [node.id, node]));
      for (const node of state.nodes) {
        const before = previous.get(node.id);
        if (!before) {
          queue.resumeRestored(state.canvasId, node.id);
        } else if (
          tasks.has(node.id) &&
          !deepEqual(
            requestInput(before, previousNodes),
            requestInput(node, state.nodes),
          )
        ) {
          invalidate(node.id);
          queue.schedule(node);
        }
      }
    },

    resumeRestored(canvasId, nodeId) {
      if (opts.getState().canvasId !== canvasId || opts.isBlocked?.(nodeId))
        return;
      const ids = interrupted.get(canvasId);
      if (!ids?.has(nodeId)) return;
      const node = opts
        .getState()
        .nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      ids.delete(nodeId);
      if (!ids.size) interrupted.delete(canvasId);
      queue.schedule(node);
    },

    schedule(node) {
      if (isExcludedFromPreprocessing(node)) return;
      if (hasMissingContent(node)) return;
      if (opts.isBlocked?.(node.id)) return;
      const scheduledState = opts.getState();
      if (!scheduledState.canvasId) return;
      const nodeId = node.id;
      const task = { canvasId: scheduledState.canvasId };
      tasks.set(nodeId, task);
      scheduledState.setNodeIngestion(nodeId, {
        status: 'pending',
        updatedAt: Date.now(),
      });
      debouncer.schedule(nodeId, () => {
        const state = opts.getState();
        if (tasks.get(nodeId) !== task) return;
        if (!state.canvasId || state.canvasId !== task.canvasId) {
          invalidate(nodeId);
          return;
        }
        // Re-fetch the latest node so we send the most up-to-date content.
        const latestNode = state.nodes.find((n) => n.id === nodeId);
        if (!latestNode) {
          queue.forgetNode(nodeId);
          return;
        }
        if (
          opts.isBlocked?.(nodeId) ||
          isExcludedFromPreprocessing(latestNode) ||
          hasMissingContent(latestNode)
        ) {
          invalidate(nodeId);
          return;
        }
        const isCurrent = () =>
          tasks.get(nodeId) === task &&
          opts.getState().canvasId === task.canvasId &&
          opts.getState().nodes.some((candidate) => candidate.id === nodeId) &&
          !opts.isBlocked?.(nodeId);
        const pending = preprocessNodeIfNeeded({
          canvasId: state.canvasId,
          node: latestNode,
          setNodeIngestion: (id, info) => {
            if (isCurrent()) state.setNodeIngestion(id, info);
          },
          clearNodeIngestion: (id) => {
            if (isCurrent()) state.clearNodeIngestion(id);
          },
          getChildNodes: (frameId) =>
            state.nodes.filter((n) => n.parentId === frameId),
          getNode: (id) =>
            opts.getState().nodes.find((candidate) => candidate.id === id),
          patchNodeSilent: (id, patch) => {
            if (isCurrent()) {
              state.patchNodeSilent(id, patch);
            }
          },
        }).catch((error: unknown) => {
          if (isCurrent())
            state.setNodeIngestion(nodeId, {
              status: 'error',
              updatedAt: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            });
        });
        inflight.add(pending);
        void pending
          .finally(() => {
            inflight.delete(pending);
            if (tasks.get(nodeId) === task) tasks.delete(nodeId);
          })
          .catch(() => undefined);
      });
    },

    cancelAll() {
      for (const id of tasks.keys()) invalidate(id);
    },

    flushKeepalive() {
      const pendingIds = debouncer.cancelAll();
      if (pendingIds.length === 0) return;

      const state = opts.getState();
      const { canvasId, nodes } = state;
      if (!canvasId) return;

      for (const nodeId of pendingIds) {
        invalidate(nodeId);
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
  return queue;
}
