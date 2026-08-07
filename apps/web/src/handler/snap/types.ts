// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

/**
 * A single guide line to render this frame.
 *
 * Discriminated by `kind`:
 *
 *   • `'alignment'`     — A simple edge-alignment guide drawn through
 *                         a single candidate-edge value (`buildGuide`
 *                         in snapEngine emits these).
 *   • `'equal-spacing'` — Source rect was placed such that the gap
 *                         to one neighbour equals the gap to a
 *                         second neighbour (middle-equal pattern) or
 *                         extends a rhythm defined by two same-side
 *                         neighbours (trailing-equal). Carries the
 *                         three participating rects sorted along
 *                         `axis` so the overlay can render the "= ="
 *                         tick markers between them.
 *
 * Both variants share the `axis` / `value` / `from` / `to` geometry
 * required to draw the primary line.
 */
type GuideBase = {
  axis: 'x' | 'y';
  /** Coordinate of the guide line in absolute flow-space. */
  value: number;
  /** Guide segment start on the parallel axis (absolute flow-space). */
  from: number;
  /** Guide segment end on the parallel axis (absolute flow-space). */
  to: number;
};

export type AlignmentGuide = GuideBase & {
  kind: 'alignment';
};

export type EqualSpacingGuide = GuideBase & {
  kind: 'equal-spacing';
  /** Rects involved in the spacing chain, sorted along `axis`. */
  rects: Rect[];
};

export type Guide = AlignmentGuide | EqualSpacingGuide;

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

/**
 * Per-axis description of which source edges may produce a snap hit.
 *
 *   `'both'` — `min`, `mid`, AND `max` edges all probe candidates.
 *              The drag default: the whole rect moves as a unit, so
 *              every edge is "live".
 *   `'min'`  — only the `min` edge (left / top) probes. Used during
 *              resize when only the top-left-side edge is moving and
 *              the opposite edge stays pinned as the anchor.
 *   `'max'`  — only the `max` edge (right / bottom) probes.
 *   `'none'` — axis disabled (e.g. an edge-handle resize that only
 *              moves the other axis).
 *
 * The `mid` edge is never reported separately for resize because the
 * centre moves implicitly with the moving edge and snapping to it
 * would feel ambiguous (anchor edge would have to shift too).
 */
export type ActiveEdges = {
  x: 'min' | 'max' | 'both' | 'none';
  y: 'min' | 'max' | 'both' | 'none';
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
  /**
   * Restrict which source edges the engine probes against candidates.
   * Default `{ x: 'both', y: 'both' }` preserves drag behaviour
   * (every edge is live). Resize callers narrow this to the
   * actually-moving edge so the anchor side never gets snapped.
   */
  activeEdges?: ActiveEdges;
  /**
   * Toggle the equal-spacing detector. Default `true` for drag.
   * Resize callers typically disable this — the equal-spacing
   * geometry assumes the rect as a whole is moving, not just one
   * edge growing, and otherwise produces confusing guide lines that
   * compete with the obvious edge-alignment intent.
   */
  enableEqualSpacing?: boolean;
};

/** Convenience extractors. */
export function rectFrom(
  pos: XYPosition,
  size: { w: number; h: number },
): Rect {
  return { x: pos.x, y: pos.y, w: size.w, h: size.h };
}
