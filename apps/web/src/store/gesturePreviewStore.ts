import { create } from 'zustand';

import type { Guide } from '@/handler/snap/types';
import type { FrameFitResult } from '@sediment/shared/canvas-engine';

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

type GesturePreviewState = {
  /** Stroke ids hidden while an eraser gesture is still uncommitted. */
  sketchErasePreview: Record<string, string[]>;

  /** Replace the transient Sketch eraser preview. */
  setSketchErasePreview: (preview: Record<string, string[]>) => void;

  /** Restore all strokes when erasing commits or is cancelled. */
  clearSketchErasePreview: () => void;

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
   * Replace the preview list. Called by `canvasStore` after it has
   * computed the fit for each affected frame.
   */
  setFrameFitPreviews: (previews: FrameFitPreview[]) => void;

  /** Clear the frame fit previews (e.g. when drag or resize ends). */
  clearFrameFitPreview: () => void;

  /**
   * Smart-snap guide lines to render this frame. Written by the snap
   * session during drag (via `canvasStore.onNodesChange`) and during
   * resize (via `NodeWrapper.handleResize`); cleared on gesture end.
   */
  snapGuides: Guide[];

  /** Replace the guide list (called every drag/resize tick). */
  setSnapGuides: (guides: Guide[]) => void;

  /** Clear the guide list when the gesture ends. */
  clearSnapGuides: () => void;

  /**
   * Live drop indicator for a node hovering over a structured
   * (column / row) frame. Absolute flow-space rect plus the picker's
   * decision (`into-existing` highlights the target track,
   * `insert-new` draws a thin bar at the gap where a new track opens).
   * Written by `canvasStore.onNodeDrag`; cleared on drag end. `null`
   * when the cursor isn't over a structured frame (free-mode frames
   * never set it).
   */
  structuredDropPreview: StructuredDropPreview | null;

  /** Replace the structured drop indicator (called every drag tick). */
  setStructuredDropPreview: (preview: StructuredDropPreview | null) => void;

  /** Clear the structured drop indicator when the gesture ends. */
  clearStructuredDropPreview: () => void;
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
  sketchErasePreview: {},
  setSketchErasePreview: (sketchErasePreview) => set({ sketchErasePreview }),
  clearSketchErasePreview: () => set({ sketchErasePreview: {} }),
  frameFitPreviews: [],
  setFrameFitPreviews: (previews) => set({ frameFitPreviews: previews }),
  clearFrameFitPreview: () => set({ frameFitPreviews: [] }),
  snapGuides: [],
  setSnapGuides: (guides) => set({ snapGuides: guides }),
  clearSnapGuides: () => set({ snapGuides: [] }),
  structuredDropPreview: null,
  setStructuredDropPreview: (preview) =>
    set({ structuredDropPreview: preview }),
  clearStructuredDropPreview: () => set({ structuredDropPreview: null }),
}));
