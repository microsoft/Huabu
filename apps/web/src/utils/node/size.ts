/**
 * @file Shared node-size helpers.
 *
 * Single source of truth for reading a canvas node's rendered dimensions.
 * Consumed by frameHelper (frame fitting), layout/graphModel (Cola/fCoSE),
 * and alignment (align/spread).
 *
 * Priority: `measured` (browser-actual) → `style` (user-set) → fallback.
 * `measured` is authoritative for auto-sizing nodes (e.g. NoteNode).
 * `style` captures explicit resize results when `measured` is stale or absent.
 */

import type { Node } from '@xyflow/react';

/**
 * Return the rendered width/height of a canvas node.
 * Returns `{ width: 0, height: 0 }` when no size information is available
 * (e.g. node not yet mounted). Callers that need a non-zero fallback for
 * layout algorithms should use `getLayoutNodeSize` instead.
 */
export function getNodeSize(node: Node): { width: number; height: number } {
  const measured = node.measured as
    | { width?: number; height?: number }
    | undefined;
  const style = node.style as
    | { width?: number | string; height?: number | string }
    | undefined;

  const width =
    (typeof measured?.width === 'number' ? measured.width : undefined) ??
    (typeof style?.width === 'number'
      ? style.width
      : typeof style?.width === 'string'
        ? Number.parseFloat(style.width)
        : undefined) ??
    0;

  const height =
    (typeof measured?.height === 'number' ? measured.height : undefined) ??
    (typeof style?.height === 'number'
      ? style.height
      : typeof style?.height === 'string'
        ? Number.parseFloat(style.height)
        : undefined) ??
    0;

  return {
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
}

/**
 * Layout-specific variant: returns `{ w, h }` with sensible non-zero defaults
 * (200 × 100) when the node has not yet been measured. Used by layout solvers
 * and alignment helpers that require a positive bounding box to compute
 * distances and avoid divide-by-zero.
 */
export function getLayoutNodeSize(node: Node): { w: number; h: number } {
  const { width, height } = getNodeSize(node);
  return {
    w: width || 200,
    h: height || 100,
  };
}
