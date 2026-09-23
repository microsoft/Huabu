// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Layout-related constants and helpers shared between the canvas-engine
 * (auto-layout, frame fitting) and web-side rendering (background grid,
 * snap-to-grid). The web `apps/web/src/config/canvas.ts` re-exports these
 * so React Flow's `<Background>` and `snapGrid` props use the same
 * source of truth.
 */

/** Size (in px) of each grid cell. Matches the `<Background gap>` prop. */
export const GRID_SIZE = 18;

/**
 * Median of the pooled `[width, height]` extents of a list of child
 * sizes. Robust against a single oversized node skewing the spacing.
 * Returns 0 for an empty list.
 */
export function medianOfChildExtents(
  sizes: readonly { width: number; height: number }[],
): number {
  if (sizes.length === 0) return 0;
  const extents: number[] = [];
  for (const s of sizes) {
    if (Number.isFinite(s.width) && s.width > 0) extents.push(s.width);
    if (Number.isFinite(s.height) && s.height > 0) extents.push(s.height);
  }
  if (extents.length === 0) return 0;
  extents.sort((a, b) => a - b);
  const mid = extents.length >> 1;
  return extents.length % 2 === 0
    ? (extents[mid - 1] + extents[mid]) / 2
    : extents[mid];
}

/**
 * Minimum halo (in px) around a free-mode frame's bounding rect inside
 * which the drag cursor still counts as "inside the frame" for the
 * purposes of:
 *   - auto-entering the frame on drop ("pointer in halo + any positive
 *     body overlap" qualifies, in addition to the area-ratio threshold)
 *   - keeping a child node parented during intra-frame drags ("pointer
 *     in halo" short-circuits the unframe-by-non-overlap test)
 *
 * Acts as a floor that callers may exceed by scaling with the dragged
 * node's size (e.g. `max(FRAME_POINTER_CAPTURE_MARGIN, nodeSize * 0.25)`)
 * so that large nodes — whose body easily extends well past a small
 * frame's edge during repositioning — still feel sticky.
 */
export const FRAME_POINTER_CAPTURE_MARGIN = 24;

/**
 * Round a coordinate to the nearest grid line.
 *
 * Used by the layout engine and alignment helpers so that programmatically
 * positioned nodes snap to the same grid the user sees.
 */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
