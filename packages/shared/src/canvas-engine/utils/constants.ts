/**
 * Layout-related constants and helpers shared between the canvas-engine
 * (auto-layout, frame fitting) and web-side rendering (background grid,
 * snap-to-grid). The web `apps/web/src/config/canvas.ts` re-exports these
 * so React Flow's `<Background>` and `snapGrid` props use the same
 * source of truth.
 */

/** Size (in px) of each grid cell. Matches the `<Background gap>` prop. */
export const GRID_SIZE = 18;

/** Default internal padding (in px) for frame nodes wrapping their children. */
export const FRAME_PADDING = 48;

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
