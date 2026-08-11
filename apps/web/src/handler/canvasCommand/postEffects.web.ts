// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Web-only drain of `PendingEffects` from the canvas engine.
 *
 * The shared engine emits a pure data manifest (`PendingEffects`)
 * describing what happened during a command batch; this module
 * translates that manifest into web verbs:
 *
 *  1. Debounced HTTP preprocessing fetch.
 *  2. Delete tracking for the local history manager.
 *  3. Deferred `fitFrames` after the DOM has reflowed.
 *
 * Pure host-agnostic cleanups (edge reroute) live in the shared
 * `applySharedPostEffects` and run BEFORE the state commit so they
 * fold into a single `set({ nodes, edges })`.
 *
 * Most dependencies (`canvasHistoryManager`) are
 * imported directly because they are module-level singletons.
 * `triggerPreprocessing` is the one exception — it is a closure over
 * the canvas store's internal state and timers, so it is passed in as
 * a callback by the store. The engine boundary stays clean either way.
 */

import {
  applyStructuredFrameRelayout,
  fitFrames,
  type NestableNode,
  type PendingEffects,
} from '@huabu/shared/canvas-engine';

import {
  canvasHistoryManager,
  type DeleteNodeMutationOptions,
} from '@/store/canvasHistoryManager';
import { useChatStore } from '@/store/chatStore';

import type { Edge, Node } from '@xyflow/react';

export interface RunWebPostEffectsInput {
  effects: PendingEffects;
  canvasId: string;
  /** Read latest committed nodes from the store. */
  getNodes: () => Node[];
  /** Read latest committed edges for edge-aware structured gutters. */
  getEdges: () => Edge[];
  /** Apply a subsequent partial node update. */
  setNodes: (nodes: Node[]) => void;
  /**
   * Debounced preprocessing trigger. Defined as a closure inside the
   * canvas store (depends on `useCanvasStore.getState()` and a private
   * timer map), so it is provided per-call rather than imported.
   */
  triggerPreprocessing: (node: Node) => void;
  /**
   * Drop all per-node save-queue bookkeeping (CAS baseline, conflict /
   * error guards, rename anchor) for a deleted node. Injected as a
   * closure over the store's private `nodeContentQueue` singleton, same
   * pattern as {@link triggerPreprocessing}, to keep this module free of
   * a back-import cycle with the canvas store.
   */
  forgetNodeContent: (nodeId: string) => void;
  /** Publication/originator plumbing for aggregate node deletes. */
  deleteMutationOptions?: DeleteNodeMutationOptions;
}

/**
 * Drain web-only effects after a command batch has been committed.
 *
 * Order matters and matches the previous `runPostEffects`:
 *  1. preprocessing trigger (synchronous fan-out into debounced fetch)
 *  2. delete tracking
 *  3. deferred frame fit (double-rAF)
 */
export function runWebPostEffects(input: RunWebPostEffectsInput): void {
  const {
    effects,
    canvasId,
    getNodes,
    getEdges,
    setNodes,
    triggerPreprocessing,
    forgetNodeContent,
    deleteMutationOptions,
  } = input;

  // 1. Trigger preprocessing for created / mutated nodes. The server
  // decides per node profile whether any actual work runs.
  //
  // `note` / `text` need special handling: their label auto-derives from
  // the first heading, so firing preprocess on every keystroke content edit
  // renamed the `.md` file through every partial heading (`Note 1.md` →
  // `H.md` → `He.md` → …). Those keystroke edits arrive as `MERGE_NODE_DATA`
  // content rewrites (their ids land in `contentEditedNodeIds`) and are
  // instead settled on exit-edit (`settleNodePreprocess`, wired from
  // `closeExpanded` / `openExpanded` for `note` and `TextNode`'s blur for
  // `text`). But a one-time structural mutation — create / duplicate /
  // import — is NOT a keystroke edit (it arrives via `CREATE_NODES` and never
  // appears in `contentEditedNodeIds`), so it still needs its single
  // preprocess pass to persist the sidecar and derive the initial label.
  // Skip only the content-edit churn path, not the create/import path.
  // See `docs/architecture/node-preprocessing.md` §4 (Triggers & state).
  const contentEdited = new Set(effects.contentEditedNodeIds);
  for (const node of effects.mutatedNodes) {
    if (
      (node.type === 'note' || node.type === 'text') &&
      contentEdited.has(node.id)
    ) {
      continue;
    }
    triggerPreprocessing(node);
  }

  // 2. Track server-side deletes for local history.
  for (const nodeId of effects.deletedNodeIds) {
    canvasHistoryManager.trackDelete(canvasId, nodeId, deleteMutationOptions);
    // Release the node's per-node save-queue state so a long session of
    // create/delete churn doesn't leak bookkeeping keyed by dead ids.
    forgetNodeContent(nodeId);
  }

  // 2b. If a deleted node was a question node whose conversation is
  // currently open in the chat panel, roll that view back to the plain
  // canvas chat so the user isn't stranded on an orphaned thread.
  if (effects.deletedNodeIds.length > 0) {
    useChatStore
      .getState()
      .handleQuestionNodesDeleted(canvasId, effects.deletedNodeIds);
  }

  // 3. Refit frames whose children need a render cycle to settle their
  // size (e.g. notes whose pinned height was just cleared). Deferred
  // via double-rAF so the inline editor can reflow and ReactFlow's
  // ResizeObserver can update `measured.height` first.
  if (effects.deferredFitFrameIds.length > 0) {
    scheduleDeferredFrameRelayout(
      effects.deferredFitFrameIds,
      getNodes,
      getEdges,
      setNodes,
    );
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────
// These are implementation details of the web post-effect drain and
// are intentionally not exported. If a future consumer needs them
// elsewhere, lift them to a separate module and add direct tests.

// Module-level coalescing state. Multiple callers in the same tick
// (e.g. a stream of ResizeObserver fires from `onNodesChange` plus a
// `SET_NODE_GEOMETRY` height-clear post-effect) collapse into a
// single double-rAF pass — without this, each call would queue its
// own double-rAF and we'd run the relayout N times for one logical
// content reflow.
const pendingRelayoutFrameIds = new Set<string>();
let pendingRelayoutScheduled = false;

/**
 * Run a structured (`column` / `row`) relayout *and* a bounding-box
 * `fitFrames` pass on the given frame IDs after the next render
 * cycle.
 *
 * Two `requestAnimationFrame` hops give the DOM time to reflow (e.g.
 * an inline editor re-laying out a note whose pinned height was just
 * cleared, or a freshly-mounted note settling on its content height)
 * and ReactFlow's ResizeObserver time to write the new measurement
 * into `node.measured` before we read it back. Multiple calls within
 * the same tick are coalesced into a single pass.
 *
 * Use this whenever a child's size has changed via something other
 * than the standard `SET_NODE_GEOMETRY` pipeline:
 *   - an explicit height clear (`measured.height` left stale on
 *     purpose because the new content height is unknown until reflow)
 *   - a content-driven measured-size change picked up by ReactFlow's
 *     internal `dimensions` change event
 *
 * Safe to call with frame IDs that no longer exist or no longer have
 * a structured layout — both passes silently skip them.
 */
export function scheduleDeferredFrameRelayout(
  frameIds: Iterable<string>,
  getNodes: () => Node[],
  getEdges: () => Edge[],
  setNodes: (nodes: Node[]) => void,
): void {
  let added = false;
  for (const id of frameIds) {
    if (!pendingRelayoutFrameIds.has(id)) {
      pendingRelayoutFrameIds.add(id);
      added = true;
    }
  }
  if (!added) return;
  if (pendingRelayoutScheduled) return;
  pendingRelayoutScheduled = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      pendingRelayoutScheduled = false;
      if (pendingRelayoutFrameIds.size === 0) return;
      const ids = Array.from(pendingRelayoutFrameIds);
      pendingRelayoutFrameIds.clear();
      const current = getNodes();
      // Structured pass first — it repositions children into tracks
      // and sets the frame's content-driven size. `fitFrames` then
      // cascades to ancestor frames so outer wrappers stay sized
      // correctly.
      const structured = applyStructuredFrameRelayout(current, ids, undefined, {
        edges: getEdges(),
      });
      const next = fitFrames(structured.nodes as NestableNode[], ids);
      if (next !== current) setNodes(next);
    });
  });
}
