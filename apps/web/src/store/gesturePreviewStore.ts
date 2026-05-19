import { create } from 'zustand';

import type { FrameFitResult } from '@/handler/canvasCommand/utils/frame';
import type { Guide } from '@/handler/snap/types';

type GesturePreviewState = {
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
  frameFitPreviews: [],
  setFrameFitPreviews: (previews) => set({ frameFitPreviews: previews }),
  clearFrameFitPreview: () => set({ frameFitPreviews: [] }),
  snapGuides: [],
  setSnapGuides: (guides) => set({ snapGuides: guides }),
  clearSnapGuides: () => set({ snapGuides: [] }),
}));
