/**
 * Canvas layout and grid configuration.
 *
 * GRID_SIZE is shared between the visual background grid, React Flow's
 * snap-to-grid behaviour, and all programmatic layout routines so that nodes
 * always align to the same visual grid.
 */

/** Size (in px) of each grid cell. Matches the `<Background gap>` prop. */
export const GRID_SIZE = 18;

/** Default internal padding (in px) for frame nodes wrapping their children. */
export const FRAME_PADDING = 48;

/** Convenience tuple expected by React Flow's `snapGrid` prop. */
export const SNAP_GRID: [number, number] = [GRID_SIZE, GRID_SIZE];

/**
 * Zoom range applied to React Flow as well as our custom trackpad-pinch and
 * touch-pinch handlers. Keeping a single source of truth ensures all gesture
 * paths clamp to the same limits.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;

/**
 * Round a coordinate to the nearest grid line.
 *
 * Used by the layout engine and alignment helpers so that programmatically
 * positioned nodes snap to the same grid the user sees.
 */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
