// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import type { Guide } from '@/handler/snap/types';
import type {
  FrameFitResult,
  NestableNode,
  StructuredDropContext,
} from '@huabu/shared/canvas-engine';

/**
 * Visual role of a frame-fit preview, used by the overlay layer to
 * paint each affected frame with a distinct style during a drag.
 *
 * - `target` — the frame the dragged node will land in (or, for
 *   resize previews, the frame currently being reshaped). Rendered as
 *   the visually-loudest accent so nested-frame scenarios make the
 *   landing target unambiguous.
 * - `source` — a frame whose child is leaving. Rendered muted to
 *   signal "this frame is about to shrink" without competing for
 *   attention with the target.
 */
export type FrameFitPreviewRole = 'target' | 'source';

/**
 * Frame-fit preview entry with a UI role tag. The geometric fields
 * come straight from {@link FrameFitResult}; `role` is added at the
 * writer site (canvas drag handler / resize-preview slice) so the
 * overlay can render target vs source distinctly without re-deriving
 * intent at paint time.
 */
export type FrameFitPreview = FrameFitResult & { role: FrameFitPreviewRole };

/**
 * The canvas-scoped transient DATA fields (no actions). Every field here is
 * purely-visual, never-persisted, never-undone state tied to the current
 * canvas geometry.
 *
 * Declared as its own type so {@link INITIAL_PREVIEW_DATA} — and therefore
 * every reset that spreads it (`resetCanvasScopedTransients`) — is
 * EXHAUSTIVE: add a transient field here and the compiler forces a matching
 * default, so a new field can never be silently omitted from the reset.
 */
type GesturePreviewData = {
  /** Stroke ids hidden while an eraser gesture is still uncommitted. */
  sketchErasePreview: Record<string, string[]>;

  /**
   * Sketch strokes currently selected by a stroke-level lasso (Stage 2),
   * keyed by sketch node id -> selected stroke ids. Unlike the other
   * entries in this store this is an ACTED-UPON selection (a floating
   * toolbar deletes / operates on it), not a per-tick drag preview — but
   * it shares the same transient, never-persisted, never-undone lifecycle,
   * so it lives here to reuse the churn-free store.
   */
  sketchStrokeSelection: Record<string, string[]>;

  /**
   * Sketch strokes to transiently HIGHLIGHT — distinct from the
   * acted-upon `sketchStrokeSelection`. Driven by hovering a chat
   * message's partial-stroke chip so the user can see which strokes that
   * turn referenced, WITHOUT disturbing the live selection. Keyed by
   * sketch node id -> stroke ids. Rendering intersects these against the
   * node's live strokes, so ids for erased strokes / deleted nodes simply
   * do not paint (deletion-safe, no cleanup needed).
   */
  sketchStrokeHighlight: Record<string, string[]>;

  /**
   * The retained lasso polygon (flow-space) for the current stroke
   * selection — GoodNotes-style: the loop stays after selection so the
   * user can drag inside it to move the strokes. `null` when there is no
   * stroke selection. Point-in-polygon against this decides move vs.
   * new-lasso.
   */
  sketchSelectionPolygon: Array<{ x: number; y: number }> | null;

  /**
   * Live translation (flow-space) applied to the selected strokes while a
   * move drag is in progress; `null` when not moving. Baked into node data
   * on pointer-up. Purely visual until commit.
   */
  sketchStrokeMovePreview: { dx: number; dy: number } | null;

  /**
   * Sketch node ids whose selected strokes must NOT apply
   * `sketchStrokeMovePreview` during a mixed move, because the node is
   * carried by a dragged ancestor (e.g. a framed sketch lassoed together
   * with its frame). The ancestor's drag already translates the node's
   * whole SVG by the group delta; adding the stroke preview on top would
   * move those strokes twice (they'd slide out of the frame). The commit
   * bake skips the same nodes for the same reason.
   */
  sketchStrokeMoveCarriedNodeIds: string[];

  /**
   * Previews of how frames would resize based on the current drag/resize.
   * One entry per affected frame — allows showing both the source frame
   * shrinking and the target frame expanding simultaneously.
   *
   * Written by `canvasStore.onNodeDrag` (during node drag) and by
   * `canvasStore.updateResizePreview` (during resize of a frame child).
   * Cleared in `canvasStore.onNodeDragStop` and on resize-end.
   */
  frameFitPreviews: FrameFitPreview[];

  /**
   * Smart-snap guide lines to render this frame. Written by the snap
   * session during drag (via `canvasStore.onNodesChange`) and during
   * resize (via `NodeWrapper.handleResize`); cleared on gesture end.
   */
  snapGuides: Guide[];

  /**
   * Live drop indicator for a node hovering over a structured
   * (column / row / grid) frame: the footprint the dragged node will
   * occupy, plus the frame's track structure and which track the drop
   * lands in. Written by `canvasStore.onNodeDrag`; cleared on drag end.
   * Free-mode frames never set it.
   */
  structuredDropPreview: StructuredDropPreview | null;

  /**
   * Complete future geometry for nodes affected by a nested Frame transaction.
   * Folded into React Flow only at the render boundary; never persisted.
   */
  nodeGeometryPreviews: ReadonlyMap<
    string,
    Pick<NestableNode, 'position' | 'style' | 'measured'>
  > | null;
};

type GesturePreviewState = GesturePreviewData & {
  /** Replace the transient Sketch eraser preview. */
  setSketchErasePreview: (preview: Record<string, string[]>) => void;

  /** Restore all strokes when erasing commits or is cancelled. */
  clearSketchErasePreview: () => void;

  /** Replace the current stroke-level selection. */
  setSketchStrokeSelection: (selection: Record<string, string[]>) => void;

  /** Clear the stroke-level selection (also drops region + move preview). */
  clearSketchStrokeSelection: () => void;

  /** Replace the transient stroke highlight. */
  setSketchStrokeHighlight: (highlight: Record<string, string[]>) => void;

  /** Clear the transient stroke highlight. */
  clearSketchStrokeHighlight: () => void;

  /** Set the retained selection polygon (flow-space). */
  setSketchSelectionPolygon: (
    polygon: Array<{ x: number; y: number }> | null,
  ) => void;

  /** Set / clear the live move-preview offset. */
  setSketchStrokeMovePreview: (
    offset: { dx: number; dy: number } | null,
  ) => void;

  /** Set / clear the carried-node ids for the current mixed move. */
  setSketchStrokeMoveCarriedNodeIds: (ids: string[]) => void;

  /**
   * Replace the preview list. Called by `canvasStore` after it has
   * computed the fit for each affected frame.
   */
  setFrameFitPreviews: (previews: FrameFitPreview[]) => void;

  /** Clear the frame fit previews (e.g. when drag or resize ends). */
  clearFrameFitPreview: () => void;

  /** Replace the guide list (called every drag/resize tick). */
  setSnapGuides: (guides: Guide[]) => void;

  /** Clear the guide list when the gesture ends. */
  clearSnapGuides: () => void;

  /** Replace the structured drop indicator (called every drag tick). */
  setStructuredDropPreview: (preview: StructuredDropPreview | null) => void;

  /** Clear the structured drop indicator when the gesture ends. */
  clearStructuredDropPreview: () => void;

  setNodeGeometryPreviews: (nodes: readonly NestableNode[]) => void;
  clearNodeGeometryPreviews: () => void;

  /**
   * Clear every canvas-scoped transient. Called on any authoritative
   * geometry swap that may strand a retained stroke selection / polygon:
   * canvas switch, authoritative reload, same-canvas SSE snapshot heal,
   * and undo / redo.
   */
  resetCanvasScopedTransients: () => void;
};

/**
 * Absolute flow-space drop indicator for a structured frame, produced
 * by {@link describeStructuredDropZone} and offset to canvas space.
 */
export type StructuredDropPreview = {
  frameId: string;
  kind: 'into-existing' | 'insert-new';
  x: number;
  y: number;
  width: number;
  height: number;
  context: StructuredDropContext;
};

/**
 * Empty value for every canvas-scoped transient. Single source of truth for
 * both the store's initial state and `resetCanvasScopedTransients`, so the
 * two can never drift and a newly-added field is reset automatically.
 */
const INITIAL_PREVIEW_DATA: GesturePreviewData = {
  sketchErasePreview: {},
  sketchStrokeSelection: {},
  sketchStrokeHighlight: {},
  sketchSelectionPolygon: null,
  sketchStrokeMovePreview: null,
  sketchStrokeMoveCarriedNodeIds: [],
  frameFitPreviews: [],
  snapGuides: [],
  structuredDropPreview: null,
  nodeGeometryPreviews: null,
};

/**
 * Transient gesture (drag / resize) preview store.
 *
 * Holds two purely-visual overlays shown while a user is interacting
 * with nodes:
 *
 * - `frameFitPreviews` — dashed outlines previewing how parent frames
 *   would resize when their children are dragged or resized.
 * - `snapGuides` — Smart-Snap alignment guides shown for *both* drag
 *   and resize gestures.
 * - `structuredDropPreview` — live drop indicator (column / row band or
 *   insert bar) shown while dragging a node over a structured frame.
 * - `nodeGeometryPreviews` — the complete future geometry tree for affected
 *   Frames and peers while a drop is being aimed.
 *
 * Lives in its own store because:
 *
 * 1. It is purely visual — never persisted, never undone.
 * 2. Its writers (drag/resize handlers + snap engine) and readers (the
 *    overlay layer in `Canvas.tsx`) don't need any of the canvas data
 *    store's actions; coupling them caused every drag tick to churn
 *    through the canvas autosave middleware.
 *
 * Kept deliberately "dumb": it owns the preview *state* but no
 * geometry knowledge. The frame-fit math lives on `canvasStore` (where
 * the nodes live) and the snap math lives on `snapSession` / `snapEngine`;
 * both push results in via the setters. This keeps the dependency
 * direction one-way (canvasStore / snapSession → gesturePreviewStore)
 * and avoids a circular import.
 */
export const useGesturePreviewStore = create<GesturePreviewState>()((set) => ({
  ...INITIAL_PREVIEW_DATA,
  setSketchErasePreview: (sketchErasePreview) => set({ sketchErasePreview }),
  clearSketchErasePreview: () => set({ sketchErasePreview: {} }),
  setSketchStrokeSelection: (sketchStrokeSelection) =>
    set({ sketchStrokeSelection }),
  clearSketchStrokeSelection: () =>
    set({
      sketchStrokeSelection: {},
      sketchSelectionPolygon: null,
      sketchStrokeMovePreview: null,
      sketchStrokeMoveCarriedNodeIds: [],
    }),
  setSketchStrokeHighlight: (sketchStrokeHighlight) =>
    set({ sketchStrokeHighlight }),
  clearSketchStrokeHighlight: () => set({ sketchStrokeHighlight: {} }),
  setSketchSelectionPolygon: (sketchSelectionPolygon) =>
    set({ sketchSelectionPolygon }),
  setSketchStrokeMovePreview: (sketchStrokeMovePreview) =>
    set({ sketchStrokeMovePreview }),
  setSketchStrokeMoveCarriedNodeIds: (sketchStrokeMoveCarriedNodeIds) =>
    set({ sketchStrokeMoveCarriedNodeIds }),
  setFrameFitPreviews: (previews) => set({ frameFitPreviews: previews }),
  clearFrameFitPreview: () => set({ frameFitPreviews: [] }),
  setSnapGuides: (guides) => set({ snapGuides: guides }),
  clearSnapGuides: () => set({ snapGuides: [] }),
  setStructuredDropPreview: (preview) =>
    set({ structuredDropPreview: preview }),
  clearStructuredDropPreview: () => set({ structuredDropPreview: null }),
  setNodeGeometryPreviews: (nodes) =>
    set((state) => {
      const current = state.nodeGeometryPreviews;
      if (nodes.length === 0) {
        return current === null ? state : { nodeGeometryPreviews: null };
      }
      const unchanged =
        current !== null &&
        current.size === nodes.length &&
        nodes.every((node) => {
          const previous = current.get(node.id);
          return (
            previous?.position.x === node.position.x &&
            previous.position.y === node.position.y &&
            previous.style?.width === node.style?.width &&
            previous.style?.height === node.style?.height &&
            previous.measured?.width === node.measured?.width &&
            previous.measured?.height === node.measured?.height
          );
        });
      if (unchanged) return state;
      return {
        nodeGeometryPreviews: new Map(
          nodes.map((node) => [
            node.id,
            {
              position: node.position,
              style: node.style,
              measured: node.measured,
            },
          ]),
        ),
      };
    }),
  clearNodeGeometryPreviews: () =>
    set((state) =>
      state.nodeGeometryPreviews === null
        ? state
        : { nodeGeometryPreviews: null },
    ),
  resetCanvasScopedTransients: () => set({ ...INITIAL_PREVIEW_DATA }),
}));
