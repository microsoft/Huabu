/**
 * Live structured-frame reflow preview.
 *
 * While a node hovers a `column` / `row` / `grid` frame, the layout
 * solver's projected child positions are written onto the REAL peers so
 * they slide aside under the cursor — instead of the drop being
 * described by a stack of translucent overlay rects. This controller
 * owns the bookkeeping that makes those transient writes reversible.
 *
 * Two invariants make the preview safe:
 *
 *   1. Every drag tick computes its drop decision against
 *      {@link StructuredReflowController.strip}ped nodes, so the
 *      preview's own output can never feed back into the next tick's
 *      decision. Without this it oscillates: reflow moves a peer → the
 *      picker's track bounds move → a different track is picked → the
 *      peer moves back → …
 *   2. `onNodeDragStop` calls {@link StructuredReflowController.clear}
 *      BEFORE dispatching `NODE_DRAG_STOP`, so the resolver's pickers
 *      see the same geometry the preview was computed from — what the
 *      user saw is what commits.
 *
 * The baseline lives in this module's closure rather than on the
 * Zustand store: no React subscriber observes it, and routing it
 * through `set` would pump the autosave middleware many times per
 * frame. Preview writes themselves go through `_setStateNoAutosave`.
 *
 * @see canvasStore.ts — instantiates the controller as a module-level
 *      singleton and drives it from `onNodeDrag` / `onNodeDragStop` /
 *      `cancelActiveNodeDrag` / `endActiveDragSession`.
 */

import type { StructuredReflowEntry } from '@sediment/shared/canvas-engine';
import type { Node } from '@xyflow/react';

export interface StructuredReflowController {
  /** Rebuild a nodes array with the live reflow preview undone. */
  strip: (nodes: Node[]) => Node[];
  /**
   * Move the frame's peers to the positions the solver projected for
   * the hovered drop, recording each peer's pre-drag position on its
   * first displacement. Peers no longer covered by `reflow` snap back
   * to their baseline. Returns `null` when nothing moved, so the caller
   * can skip the store write.
   */
  apply: (
    nodes: Node[],
    reflow: readonly StructuredReflowEntry[],
  ) => Node[] | null;
  /**
   * Undo the preview and forget the baseline. Returns `null` when there
   * was nothing to restore.
   */
  clear: (nodes: Node[]) => Node[] | null;
}

export function createStructuredReflowController(): StructuredReflowController {
  let baseline: Map<string, { x: number; y: number }> | null = null;

  const strip = (nodes: Node[]): Node[] => {
    const current = baseline;
    if (!current || current.size === 0) return nodes;
    return nodes.map((node) => {
      const base = current.get(node.id);
      if (!base) return node;
      if (base.x === node.position.x && base.y === node.position.y) return node;
      return { ...node, position: base };
    });
  };

  const apply = (
    nodes: Node[],
    reflow: readonly StructuredReflowEntry[],
  ): Node[] | null => {
    const targets = new Map(reflow.map((entry) => [entry.id, entry]));
    const next = baseline ?? new Map<string, { x: number; y: number }>();
    let changed = false;

    const result = nodes.map((node) => {
      const target = targets.get(node.id);
      const base = next.get(node.id);
      if (!target && !base) return node;
      // First displacement: the current position is still the pre-drag one.
      if (target && !base) next.set(node.id, node.position);
      const wanted = target ? { x: target.x, y: target.y } : base;
      if (!wanted) return node;
      if (wanted.x === node.position.x && wanted.y === node.position.y) {
        return node;
      }
      changed = true;
      return { ...node, position: wanted };
    });

    baseline = next.size > 0 ? next : null;
    return changed ? result : null;
  };

  const clear = (nodes: Node[]): Node[] | null => {
    if (!baseline) return null;
    const restored = strip(nodes);
    baseline = null;
    return restored === nodes ? null : restored;
  };

  return { strip, apply, clear };
}
