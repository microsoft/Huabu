import { create } from 'zustand';

import { SKETCH_ERASER_RADIUS_SCREEN_PX } from '@/config/canvas';

import type { CanvasNodeType } from '@sediment/shared';

/**
 * Node type awaiting placement on canvas via click or drawing.
 *
 * Derived from `CanvasNodeType` minus the upload-only kinds
 * (`image` / `pdf` / `video` / `web`), which never enter the canvas
 * through the toolbar's click-to-place flow. Expressing this as a
 * subset of the shared canvas-node union means adding a new canvas
 * node type will force a TS decision here, instead of silently
 * leaving the toolbar out of sync.
 */
export type PendingNodeType = Exclude<
  CanvasNodeType,
  'image' | 'pdf' | 'video' | 'web'
> | null;

/**
 * Active sketch tool settings — color, thickness, and tool mode used by
 * the live SketchOverlay preview and persisted onto each new sketch node
 * so the same look replays after reload. Per-node values are still
 * editable after-the-fact via the sketch node's toolbar.
 *
 * `mode` switches the overlay between drawing new strokes (`'draw'`) and
 * erasing existing sketch nodes (`'erase'`).
 */
export type SketchDraft = {
  strokeColor: string;
  strokeSize: number;
  /**
   * Eraser brush radius (screen-space px) used by the sketch tool's
   * erase mode. Independent of `strokeSize` so changing the eraser
   * size doesn't disturb the active draw thickness, and vice versa.
   */
  eraserSize: number;
  mode: 'draw' | 'erase';
};

type ToolState = {
  pendingNodeType: PendingNodeType;
  sketchDraft: SketchDraft;
  setPendingNodeType: (type: PendingNodeType) => void;
  setSketchDraft: (patch: Partial<SketchDraft>) => void;
  /**
   * Called by `canvasStore.switchCanvas` to clear transient tool state
   * that should not survive a canvas switch (`pendingNodeType`).
   *
   * `sketchDraft` is intentionally NOT reset — users expect their
   * brush color/size to persist across canvases.
   */
  resetForCanvasSwitch: () => void;
};

const DEFAULT_SKETCH_DRAFT: SketchDraft = {
  strokeColor: 'black',
  strokeSize: 4,
  eraserSize: SKETCH_ERASER_RADIUS_SCREEN_PX,
  mode: 'draw',
};

/**
 * Toolbar / tool-settings store.
 *
 * Holds the two pieces of UI state that belong to the canvas *toolbox*
 * rather than to the canvas data itself:
 *
 * - `pendingNodeType` — the node type the user has armed for placement
 *   via click-to-place or drag-to-create. Reset on canvas switch.
 * - `sketchDraft` — the active sketch tool's color, thickness, eraser
 *   size, and mode. Kept across canvas switches as a user preference.
 *
 * Extracted from `canvasStore` so the canvas data store can stay focused
 * on persisted nodes/edges.
 */
export const useToolStore = create<ToolState>()((set) => ({
  pendingNodeType: null,
  sketchDraft: DEFAULT_SKETCH_DRAFT,
  setPendingNodeType: (type) => set({ pendingNodeType: type }),
  setSketchDraft: (patch) =>
    set((state) => ({ sketchDraft: { ...state.sketchDraft, ...patch } })),
  resetForCanvasSwitch: () => set({ pendingNodeType: null }),
}));
