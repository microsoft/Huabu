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
 * Round a coordinate to the nearest grid line.
 *
 * Used by the layout engine and alignment helpers so that programmatically
 * positioned nodes snap to the same grid the user sees.
 */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
