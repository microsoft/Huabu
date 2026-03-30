/**
 * Post-commit side effects that run after the executor has applied
 * a command batch and the store has committed the new state.
 */

import { LAYOUT_ANIMATION_DURATION_MS } from '@/handler/autoLayout/applier';
import { canvasHistoryManager } from '@/store/canvasHistoryManager';
import { rerouteAllEdges } from '@/utils/node/helper';

import type { CanvasEffectCallbacks } from './runtime';
import type { Node, Edge } from '@xyflow/react';

/** Accumulated side-effect requests collected during a batch execution. */
export interface PendingEffects {
  /** Nodes that need preprocessing (ingestion, label resolution, or both). */
  preprocessNodes: Node[];
  /** Node IDs that were deleted and need server-side tracking. */
  deletedNodeIds: string[];
  /** Whether layout animation CSS transitions need cleanup after animation. */
  needsTransitionCleanup: boolean;
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
}

/**
 * Schedule cleanup of CSS transition styles after a layout animation completes.
 * Extracted from the duplicated setTimeout blocks in layoutAll / layoutGroup.
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
