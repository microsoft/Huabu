// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// ── Spatial geometry primitives ──────────────────────────────────
//
// Pure rectangle / point math. Zero dependencies, no concept of
// canvas nodes — just numbers and shapes.
//
// Used by both web (sketch stroke clustering) and server
// (spatial agent tools).

import type { Point } from '../../types/canvas/layout.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Center point of a rectangle. */
export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Euclidean distance between two points. */
export function pointDistance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance between the centers of two rectangles. */
export function rectCenterDistance(a: Rect, b: Rect): number {
  return pointDistance(rectCenter(a), rectCenter(b));
}

/**
 * Shortest distance between the edges of two rectangles.
 * Returns 0 when they overlap.
 */
export function rectEdgeDistance(a: Rect, b: Rect): number {
  const dx = Math.max(
    0,
    Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)),
  );
  const dy = Math.max(
    0,
    Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)),
  );
  return Math.sqrt(dx * dx + dy * dy);
}

/** Whether two rectangles overlap (share a positive area). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Area of the intersection of two rectangles (0 when disjoint). */
export function rectIntersectionArea(a: Rect, b: Rect): number {
  const overlapX = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  );
  const overlapY = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  );
  return overlapX * overlapY;
}

export type CardinalDirection = 'left' | 'right' | 'above' | 'below';

/**
 * The primary cardinal direction of `b` relative to `a`.
 *
 * Edge-aware, not center-aware: a pure center-delta classifier breaks
 * down when the two rectangles have very different sizes (e.g. a tall
 * frame next to a small note in its upper-right corner — the centers
 * say "above" even though the note is entirely beyond the frame's
 * right edge). We instead classify by axis-extent overlap:
 *
 *   - If `b` overlaps `a` on the Y axis but is separated on X
 *     → `left` / `right`.
 *   - If `b` overlaps `a` on the X axis but is separated on Y
 *     → `above` / `below`.
 *   - If the rectangles intersect (overlap on both axes), fall back
 *     to center-to-center delta.
 *   - If they're diagonally separated (no overlap on either axis),
 *     the axis with the larger edge gap wins — that's the direction
 *     with clearer visual separation.
 */
export function relativeDirection(a: Rect, b: Rect): CardinalDirection {
  // Signed edge gaps: positive when `b` is fully past the corresponding
  // edge of `a`. Negative (or zero) means the two rectangles overlap on
  // that axis.
  const gapLeft = a.x - (b.x + b.width); // > 0: b is fully left of a
  const gapRight = b.x - (a.x + a.width); // > 0: b is fully right of a
  const gapAbove = a.y - (b.y + b.height); // > 0: b is fully above a
  const gapBelow = b.y - (a.y + a.height); // > 0: b is fully below a

  const overlapsX = gapLeft <= 0 && gapRight <= 0;
  const overlapsY = gapAbove <= 0 && gapBelow <= 0;

  // Clean axial separation — the unambiguous case the old center-delta
  // logic would routinely get wrong for tall/wide neighbours.
  if (overlapsY && !overlapsX) {
    return gapRight > 0 ? 'right' : 'left';
  }
  if (overlapsX && !overlapsY) {
    return gapBelow > 0 ? 'below' : 'above';
  }

  // Rectangles intersect: edge gaps are all ≤ 0, so fall back to
  // center-to-center delta to pick the dominant axis.
  if (overlapsX && overlapsY) {
    const ca = rectCenter(a);
    const cb = rectCenter(b);
    const dx = cb.x - ca.x;
    const dy = cb.y - ca.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? 'right' : 'left';
    }
    return dy >= 0 ? 'below' : 'above';
  }

  // Diagonal: pick the axis with the larger gap (i.e. the direction
  // with the larger separation).
  const horizGap = Math.max(gapLeft, gapRight);
  const vertGap = Math.max(gapAbove, gapBelow);
  if (horizGap >= vertGap) {
    return gapRight > 0 ? 'right' : 'left';
  }
  return gapBelow > 0 ? 'below' : 'above';
}
