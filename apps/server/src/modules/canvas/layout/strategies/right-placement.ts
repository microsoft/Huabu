/**
 * Right Placement Strategy
 *
 * Places new research content to the right of existing canvas content.
 * Best for: vertical layouts, related content
 */

import type { Bounds, Point } from '@sediment/shared';

export interface RightPlacementOptions {
  /** Horizontal padding from existing content (default: 200) */
  padding?: number;
  /** Align with top, center, or bottom of existing content */
  align?: 'top' | 'center' | 'bottom';
}

/**
 * Calculate starting position for right placement
 *
 * @param existingBounds - Bounding box of existing canvas content
 * @param options - Placement options
 * @returns Starting position for first research node
 */
export function placeResearchRight(
  existingBounds: Bounds,
  options: RightPlacementOptions = {},
): Point {
  const { padding = 200, align = 'top' } = options;

  const x = existingBounds.maxX + padding;

  let y: number;
  switch (align) {
    case 'center':
      y = existingBounds.minY + (existingBounds.maxY - existingBounds.minY) / 2;
      break;
    case 'bottom':
      y = existingBounds.maxY;
      break;
    case 'top':
    default:
      y = existingBounds.minY;
      break;
  }

  return { x, y };
}
