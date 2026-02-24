/**
 * Bottom Placement Strategy
 *
 * Places new research content below existing canvas content.
 * Best for: horizontal layouts, sequential workflows
 */

import type { Bounds, Point } from '@sediment/shared';

export interface BottomPlacementOptions {
  /** Vertical padding from existing content (default: 200) */
  padding?: number;
  /** Align with left, center, or right of existing content */
  align?: 'left' | 'center' | 'right';
}

/**
 * Calculate starting position for bottom placement
 *
 * @param existingBounds - Bounding box of existing canvas content
 * @param options - Placement options
 * @returns Starting position for first research node
 */
export function placeResearchBottom(
  existingBounds: Bounds,
  options: BottomPlacementOptions = {},
): Point {
  const { padding = 200, align = 'left' } = options;

  const y = existingBounds.maxY + padding;

  let x: number;
  switch (align) {
    case 'center':
      x = existingBounds.minX + (existingBounds.maxX - existingBounds.minX) / 2;
      break;
    case 'right':
      x = existingBounds.maxX;
      break;
    case 'left':
    default:
      x = existingBounds.minX;
      break;
  }

  return { x, y };
}
