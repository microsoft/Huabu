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
  /** Reconsider waiting work after the restored sidecar has committed. */
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
  type Task = {
    canvasId: string;
    phase: 'queued' | 'blocked' | 'running' | 'deleted';
    input?: ReturnType<typeof requestInput>;
  };
  // One record owns demand, readiness and response validity. Issued promises
  // are tracked separately only because DELETE must drain superseded work too.
  const tasks = new Map<string, Task>();

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

  function canProcess(node: Node): boolean {
    return !isExcludedFromPreprocessing(node) && !hasMissingContent(node);
  }

  function ownsTask(nodeId: string, task: Task): boolean {
    return (
      tasks.get(nodeId) === task && opts.getState().canvasId === task.canvasId
    );
  }

  function canProject(nodeId: string, task: Task): boolean {
    const state = opts.getState();
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    if (
      !ownsTask(nodeId, task) ||
      task.phase !== 'running' ||
      !node ||
      !canProcess(node) ||
      opts.isBlocked?.(nodeId)
    )
      return false;
    const current = requestInput(node, state.nodes);
    // The helper already suppresses automatic labels after a protected rename.
    // Preserve useful extracted content when only that ownership changed.
    if (
      typeof node.data.label === 'string' &&
      node.data.label.trim() &&
      (node.data.labelSource === 'user' || node.data.labelSource === 'agent') &&
      task.input
    ) {
      current.snapshot.title = task.input.snapshot.title;
      current.snapshot.labelSource = task.input.snapshot.labelSource;
    }
    return deepEqual(task.input, current);
  }

  function markPending(nodeId: string): void {
    opts
      .getState()
      .setNodeIngestion(nodeId, { status: 'pending', updatedAt: Date.now() });
  }

  function start(nodeId: string, task: Task): void {
    if (!ownsTask(nodeId, task)) return;
    const state = opts.getState();
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      queue.forgetNode(nodeId);
      return;
    }
    if (!canProcess(node)) {
      invalidate(nodeId);
      return;
    }
    if (opts.isBlocked?.(nodeId)) {
      task.phase = 'blocked';
      return;
    }
    task.phase = 'running';
    task.input = requestInput(node, state.nodes);
    const pending = preprocessNodeIfNeeded({
      canvasId: task.canvasId,
      node,
      setNodeIngestion: (id, info) => {
        if (canProject(nodeId, task)) state.setNodeIngestion(id, info);
      },
      clearNodeIngestion: (id) => {
        if (canProject(nodeId, task)) state.clearNodeIngestion(id);
      },
      getChildNodes: (id) =>
        state.nodes.filter((child) => child.parentId === id),
      getNode: (id) =>
        opts.getState().nodes.find((candidate) => candidate.id === id),
      patchNodeSilent: (id, patch) => {
        if (!canProject(nodeId, task)) return;
        state.patchNodeSilent(id, patch);
        // The accepted result may canonicalize src/content/label. Its own
        // projection must not invalidate the terminal ingestion callback.
        const latest = opts.getState();
        const projected = latest.nodes.find((candidate) => candidate.id === id);
        if (ownsTask(nodeId, task) && projected)
          task.input = requestInput(projected, latest.nodes);
      },
    }).catch((error: unknown) => {
      if (canProject(nodeId, task))
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
        if (tasks.get(nodeId) !== task) return;
        // A stale response ends only its own spinner. Input edits alone do not
        // trigger another request: Note/Text still wait for explicit edit-settle.
        if (ownsTask(nodeId, task) && !canProject(nodeId, task))
          state.clearNodeIngestion(nodeId);
        tasks.delete(nodeId);
      })
      .catch(() => undefined);
  }

  const queue: PreprocessQueue = {
    async waitForIdle() {
      await Promise.all(inflight);
    },

    forgetNode(nodeId) {
      const task = tasks.get(nodeId);
      if (!task || task.phase === 'deleted') return;
      invalidate(nodeId);
      tasks.set(nodeId, { canvasId: task.canvasId, phase: 'deleted' });
    },

    reconcileHistory(previousNodes) {
      const state = opts.getState();
      const previous = new Map(previousNodes.map((node) => [node.id, node]));
      for (const before of previousNodes) {
        if (!state.nodes.some((node) => node.id === before.id))
          queue.forgetNode(before.id);
      }
      for (const node of state.nodes) {
        const before = previous.get(node.id);
        const task = tasks.get(node.id);
        if (!before) {
          queue.resumeRestored(state.canvasId, node.id);
        } else if (
          task?.canvasId === state.canvasId &&
          !deepEqual(
            task.phase === 'running'
              ? task.input
              : requestInput(before, previousNodes),
            requestInput(node, state.nodes),
          )
        ) {
          invalidate(node.id);
          queue.schedule(node);
        }
      }
    },

    resumeRestored(canvasId, nodeId) {
      const task = tasks.get(nodeId);
      if (
        opts.getState().canvasId !== canvasId ||
        task?.canvasId !== canvasId ||
        (task.phase !== 'deleted' && task.phase !== 'blocked')
      )
        return;
      const node = opts
        .getState()
        .nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      queue.schedule(node);
    },

    schedule(node) {
      const scheduledState = opts.getState();
      if (!scheduledState.canvasId) return;
      const nodeId = node.id;
      if (!canProcess(node)) {
        invalidate(nodeId);
        return;
      }
      debouncer.cancel(nodeId);
      const task: Task = {
        canvasId: scheduledState.canvasId,
        phase: opts.isBlocked?.(nodeId) ? 'blocked' : 'queued',
      };
      tasks.set(nodeId, task);
      markPending(nodeId);
      if (task.phase === 'queued')
        debouncer.schedule(nodeId, () => start(nodeId, task));
    },

    cancelAll() {
      for (const [id, task] of tasks) {
        if (task.phase !== 'deleted') invalidate(id);
      }
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
