/**
 * Smart-snap types shared between the engine, the canvas store, and
 * the overlay renderer.
 *
 * All coordinates are in **absolute flow-space** unless explicitly
 * documented otherwise. The overlay layer converts to screen-space at
 * render time using `rfInstance.flowToScreenPosition`.
 */

import type { XYPosition } from '@xyflow/react';

/** Axis-aligned rectangle in absolute flow-space. */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * A pre-computed alignment line contributed by a candidate node.
 *
 * `value` is the line's coordinate on the perpendicular axis (the X
 * value for vertical lines / "x"-axis lines, the Y value for horizontal
 * lines / "y"-axis lines). `from` / `to` describe the candidate node's
 * extent on the parallel axis so the overlay can draw a segment that
 * spans both the candidate and the dragged source rect.
 */
export type CandidateLine = {
  axis: 'x' | 'y';
  /** The aligned coordinate. */
  value: number;
  /** Which part of the candidate rect this line represents. */
  edge: 'min' | 'mid' | 'max';
  /** Candidate node id (used for guide highlighting / debugging). */
  nodeId: string;
  /** Candidate rect extent on the parallel axis — min. */
  from: number;
  /** Candidate rect extent on the parallel axis — max. */
  to: number;
};

/**
 * Pre-built index of candidate alignment lines. Built once per drag
 * (`onNodeDragStart`) so per-frame snap evaluation is O(log n).
 *
 * Both arrays are sorted by `value` to enable binary-search nearest
 * lookups inside `computeSnap`.
 */
export type SnapIndex = {
  /** Vertical candidate lines, sorted by `value` (== x coordinate). */
  byX: CandidateLine[];
  /** Horizontal candidate lines, sorted by `value` (== y coordinate). */
  byY: CandidateLine[];
  /**
   * Candidate rects keyed by axis-spacing bucket — used by the
   * equal-spacing detector. Empty in v1's first slice; populated in
   * the equal-spacing pass.
   */
  rectsById: Map<string, Rect>;
};

/** A single guide line to render this frame. */
export type Guide = {
  axis: 'x' | 'y';
  /** Coordinate of the guide line in absolute flow-space. */
  value: number;
  /** Guide segment start on the parallel axis (absolute flow-space). */
  from: number;
  /** Guide segment end on the parallel axis (absolute flow-space). */
  to: number;
  /**
   * Optional secondary annotation — for equal-spacing guides, the two
   * sibling rects that participate so the overlay can render the
   * twin "= =" segments between them. Undefined for plain alignment
   * guides.
   */
  equalSpacing?: {
    /** Rects involved in the equal-spacing chain, sorted along `axis`. */
    rects: Rect[];
  };
};

/** Result of one snap evaluation. */
export type SnapResult = {
  /**
   * Position correction to apply to every dragged node, in
   * absolute flow-space units. Adding `(deltaX, deltaY)` to the
   * positions React Flow produced this frame yields the snapped
   * positions.
   */
  deltaX: number;
  deltaY: number;
  /** Guide lines to display this frame (at most one per axis class). */
  guides: Guide[];
};

/** Options consumed by `computeSnap`. */
export type SnapOptions = {
  /**
   * Snap threshold expressed in **flow-space** units. Callers convert
   * from the screen-space constant via `SNAP_THRESHOLD_SCREEN_PX / zoom`
   * so the perceived radius stays constant across zoom levels.
   */
  thresholdFlow: number;
  /**
   * When true, the engine returns zero deltas and empty guides. Used
   * when the user holds the bypass modifier (Alt) to temporarily
   * disable snapping for fine positioning.
   */
  bypass: boolean;
};

/** Convenience extractors. */
export function rectFrom(
  pos: XYPosition,
  size: { w: number; h: number },
): Rect {
  return { x: pos.x, y: pos.y, w: size.w, h: size.h };
}
