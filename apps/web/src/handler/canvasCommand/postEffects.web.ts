/**
 * Web-only drain of `PendingEffects` from the canvas engine.
 *
 * The shared engine emits a pure data manifest (`PendingEffects`)
 * describing what happened during a command batch; this module
 * translates that manifest into web verbs:
 *
 *  1. Debounced HTTP preprocessing fetch.
 *  2. Delete tracking for the local history manager.
 *  3. AI-content-edit flag for the editor (gated by `source === 'agent'`).
 *  4. CSS transition style cleanup after the layout animation.
 *  5. Deferred `fitFrames` after the DOM has reflowed.
 *
 * Pure host-agnostic cleanups (edge reroute) live in the shared
 * `applySharedPostEffects` and run BEFORE the state commit so they
 * fold into a single `set({ nodes, edges })`.
 *
 * Most dependencies (`canvasHistoryManager`, `markAiContentEdit`) are
 * imported directly because they are module-level singletons.
 * `triggerPreprocessing` is the one exception — it is a closure over
 * the canvas store's internal state and timers, so it is passed in as
 * a callback by the store. The engine boundary stays clean either way.
 */

import {
  LAYOUT_ANIMATION_DURATION_MS,
  fitFrames,
  type NestableNode,
  type PendingEffects,
} from '@sediment/shared/canvas-engine';

import { canvasHistoryManager } from '@/store/canvasHistoryManager';
import { markAiContentEdit } from '@/utils/aiEditFlags';

import type { CanvasExecutionSource } from '@sediment/shared';
import type { Node } from '@xyflow/react';

/**
 * Source of the executed batch. Re-exports `CanvasExecutionSource`
 * under a local alias so callers don't have to import two type names.
 * Only `'agent'` batches mark content rewrites as AI-authored.
 */
export type CanvasBatchSource = CanvasExecutionSource;

export interface RunWebPostEffectsInput {
  effects: PendingEffects;
  source: CanvasBatchSource;
  canvasId: string;
  /** Read latest committed nodes from the store. */
  getNodes: () => Node[];
  /** Apply a subsequent partial node update. */
  setNodes: (nodes: Node[]) => void;
  /**
   * Debounced preprocessing trigger. Defined as a closure inside the
   * canvas store (depends on `useCanvasStore.getState()` and a private
   * timer map), so it is provided per-call rather than imported.
   */
  triggerPreprocessing: (node: Node) => void;
}

/**
 * Drain web-only effects after a command batch has been committed.
 *
 * Order matters and matches the previous `runPostEffects`:
 *  1. preprocessing trigger (synchronous fan-out into debounced fetch)
 *  2. delete tracking
 *  3. AI flag marking (agent batches only)
 *  4. transition cleanup (setTimeout)
 *  5. deferred frame fit (double-rAF)
 */
export function runWebPostEffects(input: RunWebPostEffectsInput): void {
  const {
    effects,
    source,
    canvasId,
    getNodes,
    setNodes,
    triggerPreprocessing,
  } = input;

  // 1. Trigger preprocessing for affected nodes.
  for (const node of effects.preprocessNodes) {
    triggerPreprocessing(node);
  }

  // 2. Track server-side deletes for local history.
  for (const nodeId of effects.deletedNodeIds) {
    canvasHistoryManager.trackDelete(canvasId, nodeId);
  }

  // 3. Flag AI-authored content rewrites. The engine reports content
  // edits agnostically; only agent-initiated batches translate into
  // the editor's "AI rewrite" decoration.
  if (source === 'agent' && effects.contentEditedNodeIds.length > 0) {
    for (const nodeId of effects.contentEditedNodeIds) {
      markAiContentEdit(nodeId);
    }
  }

  // 4. Clean up layout-animation CSS transition styles after the
  // animation completes.
  if (effects.needsTransitionCleanup) {
    scheduleTransitionCleanup(getNodes, setNodes);
  }

  // 5. Refit frames whose children need a render cycle to settle their
  // size (e.g. notes whose pinned height was just cleared). Deferred
  // via double-rAF so the inline editor can reflow and ReactFlow's
  // ResizeObserver can update `measured.height` first.
  if (effects.deferredFitFrameIds.length > 0) {
    const uniqueIds = Array.from(new Set(effects.deferredFitFrameIds));
    scheduleDeferredFrameFit(uniqueIds, getNodes, setNodes);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────
// These are implementation details of the web post-effect drain and
// are intentionally not exported. If a future consumer needs them
// elsewhere, lift them to a separate module and add direct tests.

/**
 * Schedule cleanup of CSS transition styles after a layout animation
 * completes. Uses `setTimeout` (not rAF) because the duration must
 * match the animation length precisely.
 */
function scheduleTransitionCleanup(
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
 * back. Safe to call with frame IDs that no longer exist — `fitFrames`
 * silently skips them.
 */
function scheduleDeferredFrameFit(
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
