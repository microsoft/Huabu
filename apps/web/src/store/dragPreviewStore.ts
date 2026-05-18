import { create } from 'zustand';

import type { FrameFitResult } from '@/handler/canvasCommand/utils/frame';

type DragPreviewState = {
  /**
   * Previews of how frames would resize based on the current drag/resize.
   * One entry per affected frame — allows showing both the source frame
   * shrinking and the target frame expanding simultaneously.
   *
   * Written by `canvasStore.onNodeDrag` (during node drag) and by
   * `canvasStore.updateResizePreview` (during resize of a frame child).
   * Cleared in `canvasStore.onNodeDragStop` and on resize-end.
   */
  frameFitPreviews: FrameFitResult[];

  /**
   * Replace the preview list. Called by `canvasStore` after it has
   * computed the fit for each affected frame.
   */
  setFrameFitPreviews: (previews: FrameFitResult[]) => void;

  /** Clear the frame fit previews (e.g. when drag or resize ends). */
  clearFrameFitPreview: () => void;
};

/**
 * Transient drag/resize preview store.
 *
 * Holds the dashed frame-fit overlays shown while a user is dragging
 * a node between frames or resizing a frame's child. Lives in its own
 * store because:
 *
 * 1. It is purely visual — never persisted, never undone.
 * 2. Its writers (drag/resize handlers) and readers (the overlay layer
 *    in `Canvas.tsx`) don't need any of the canvas data store's
 *    actions; coupling them caused every drag tick to churn through
 *    the canvas autosave middleware.
 *
 * Kept deliberately "dumb": it owns the preview *state* but no
 * geometry knowledge. The frame-fit math lives on `canvasStore` (where
 * the nodes live) and the result is pushed in via `setFrameFitPreviews`.
 * This keeps the dependency direction one-way (canvasStore → dragPreviewStore)
 * and avoids a circular import.
 */
export const useDragPreviewStore = create<DragPreviewState>()((set) => ({
  frameFitPreviews: [],
  setFrameFitPreviews: (previews) => set({ frameFitPreviews: previews }),
  clearFrameFitPreview: () => set({ frameFitPreviews: [] }),
}));
