/**
 * Post-commit side effects that run after the executor has applied
 * a command batch and the store has committed the new state.
 */

import {
  LAYOUT_ANIMATION_DURATION_MS,
  fitFrames,
  rerouteAllEdges,
  type NestableNode,
  type PendingEffects,
} from '@sediment/shared/canvas-engine';

import { canvasHistoryManager } from '@/store/canvasHistoryManager';

import type { Node, Edge } from '@xyflow/react';

export type { PendingEffects };

/**
 * Post-commit side-effect callbacks provided by the host (web store).
 *
 * Lives in the web layer because it describes a host concern (the
 * debounced HTTP fetch that triggers preprocessing in the browser),
 * not engine semantics. The shared canvas-engine never invokes these
 * callbacks — it only emits `PendingEffects`, which `runPostEffects`
 * drains here using the host-provided callbacks.
 */
export interface CanvasEffectCallbacks {
  triggerPreprocessing: (node: Node) => void;
}

/**
 * Run all post-commit side effects after a batch has been applied.
 *
 * @param effects — accumulated from individual command handler results
 * @param callbacks — debounced ingestion / label-resolve triggers from the store
 * @param requiresEdgeReroute — whether any command in the batch moved nodes
 * @param canvasId — current canvas ID for delete tracking
 * @param getLatest — reads the latest committed nodes/edges from the store
 * @param set — writes edge reroute results back to the store
 */
export function runPostEffects(
  effects: PendingEffects,
  callbacks: CanvasEffectCallbacks,
  requiresEdgeReroute: boolean,
  canvasId: string,
  getLatest: () => { nodes: Node[]; edges: Edge[] },
  set: (partial: { nodes?: Node[]; edges?: Edge[] }) => void,
): void {
  // 1. Reroute edge handles if any command changed node geometry.
  if (requiresEdgeReroute) {
    const latest = getLatest();
    const rerouted = rerouteAllEdges(latest.nodes, latest.edges);
    if (rerouted !== latest.edges) {
      set({ edges: rerouted });
    }
  }

  // 2. Trigger preprocessing for affected nodes.
  for (const node of effects.preprocessNodes) {
    callbacks.triggerPreprocessing(node);
  }

  // 3. Track server-side deletes.
  for (const nodeId of effects.deletedNodeIds) {
    canvasHistoryManager.trackDelete(canvasId, nodeId);
  }

  // 4. Clean up CSS transition styles after layout animation completes.
  if (effects.needsTransitionCleanup) {
    scheduleTransitionCleanup(
      () => getLatest().nodes,
      (nodes) => set({ nodes }),
    );
  }

  // 5. Refit frames whose children need a render cycle to settle their
  // size (e.g. notes whose pinned height was just cleared). Deferred
  // via double-rAF so the inline editor can reflow and ReactFlow's
  // ResizeObserver can update `measured.height` first.
  if (effects.deferredFitFrameIds.length > 0) {
    const uniqueIds = Array.from(new Set(effects.deferredFitFrameIds));
    scheduleDeferredFrameFit(
      uniqueIds,
      () => getLatest().nodes,
      (nodes) => set({ nodes }),
    );
  }
}

/**
 * Schedule cleanup of CSS transition styles after a layout animation completes.
 */
export function scheduleTransitionCleanup(
  getNodes: () => Node[],
  setNodes: (nodes: Node[]) => void,
): void {
  setTimeout(() => {
    const currentNodes = getNodes();
    const cleaned = currentNodes.map((n) => {
      const s = n.style as Record<string, unknown> | undefined;
      if (!s?.transition) return n;
      const { transition: _t, ...rest } = s;
      return { ...n, style: rest as Node['style'] };
    });
    setNodes(cleaned);
  }, LAYOUT_ANIMATION_DURATION_MS);
}

/**
 * Refit one or more frames to their current children after the next
 * render cycle. Two `requestAnimationFrame` hops give the DOM time to
 * reflow (e.g. the inline editor re-laying out a note whose pinned
 * height was just cleared) and ReactFlow's ResizeObserver time to
 * write the new measurement into `node.measured` before we read it
 * back.
 *
 * Safe to call with frame IDs that no longer exist — `fitFrames`
 * silently skips them.
 */
export function scheduleDeferredFrameFit(
  frameIds: string[],
  getNodes: () => Node[],
  setNodes: (nodes: Node[]) => void,
): void {
  if (frameIds.length === 0) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const current = getNodes();
      const next = fitFrames(current as NestableNode[], frameIds);
      if (next !== current) setNodes(next);
    });
  });
}
