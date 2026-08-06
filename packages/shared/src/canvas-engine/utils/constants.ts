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
 * Lower bound (px) on the dynamically-derived frame padding. Below the
 * floor a frame's label/toolbar would run out of room. No upper bound
 * is enforced: padding scales linearly with content above the floor so
 * the proportionality between padding, gap, and content stays exact
 * during a uniform child-scaling resize (otherwise an upper clamp
 * decouples padding from the scale factor and the frame body settles
 * smaller than the user's drag rect — visible as bottom/right edges
 * gaining extra inset relative to top/left during the gesture).
 */
const FRAME_PADDING_MIN = 16;

/**
 * Fraction of a representative child extent (median of pooled widths
 * and heights) that becomes the frame's internal padding. Paired with
 * `gapFromExtent`'s 0.08 ratio — padding ≈ 2× gap — so the outer
 * breathing room reads as a clear step up from the inter-item spacing.
 */
const FRAME_PADDING_TO_EXTENT_RATIO = 0.1;

/**
 * Derive a frame's internal padding from a representative child
 * extent — typically the median of all direct children's pooled
 * widths + heights ({@link medianOfChildExtents}). A purely-derived
 * value paired with the layout engine's `gapFromExtent`: as a frame's
 * content scales up, padding scales with it.
 *
 * For an empty or invalid extent the function falls back to
 * {@link FRAME_PADDING_MIN} (the lower-bound floor) — this keeps the
 * transition smooth as the first child arrives (a tiny child whose
 * extent ≤ floor/ratio also resolves to the floor, so empty →
 * first-child sees no visible jump). Any positive extent is then
 * scaled by {@link FRAME_PADDING_TO_EXTENT_RATIO} and floored at the
 * same minimum. There is no upper clamp: padding grows unbounded with
 * content so a uniform-scale resize keeps the frame body flush with
 * the user's drag rect (see {@link FRAME_PADDING_MIN} for the
 * rationale).
 */
export function paddingFromExtent(extent: number): number {
  if (!Number.isFinite(extent) || extent <= 0) return FRAME_PADDING_MIN;
  return Math.max(FRAME_PADDING_MIN, extent * FRAME_PADDING_TO_EXTENT_RATIO);
}

/**
 * Median of the pooled `[width, height]` extents of a list of child
 * sizes. Robust against a single oversized node skewing the spacing.
 * Returns 0 for an empty list — callers typically feed this into
 * {@link paddingFromExtent}, which has its own fallback.
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
