// ── Spatial geometry primitives ──────────────────────────────────
//
// Pure rectangle / point math. Zero dependencies, no concept of
// canvas nodes — just numbers and shapes.
//
// Used by both web (annotation stroke clustering) and server
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
 * Uses center-to-center delta; the dominant axis wins.
 */
export function relativeDirection(a: Rect, b: Rect): CardinalDirection {
  const ca = rectCenter(a);
  const cb = rectCenter(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'below' : 'above';
}
