/**
 * Auto Placement Strategy
 *
 * Intelligently chooses between right and bottom placement based on
 * the existing canvas layout and available space.
 */

import { calculateAspectRatio } from '../bounds.calculator.js';
import { placeResearchBottom } from './bottom-placement.js';
import { placeResearchRight } from './right-placement.js';

import type { Bounds, PlacementStrategy, Point } from '@sediment/shared';

export interface AutoPlacementOptions {
  padding?: number;
  /** Viewport dimensions (for checking available space) */
  viewport?: { width: number; height: number };
}

/**
 * Automatically select the best placement strategy
 *
 * Decision logic:
 * 1. If canvas is empty -> use default position (100, 100)
 * 2. If aspect ratio > 1.5 (wide) -> place bottom
 * 3. If aspect ratio < 0.66 (tall) -> place right
 * 4. If right side has > 600px space -> place right
 * 5. Otherwise -> place bottom
 *
 * @param existingBounds - Existing canvas bounds (null if empty)
 * @param options - Placement options
 * @returns Selected strategy and starting position
 */
export function autoSelectPlacement(
  existingBounds: Bounds | null,
  options: AutoPlacementOptions = {},
): { strategy: PlacementStrategy; position: Point } {
  const { padding = 200, viewport } = options;

  // Empty canvas: start at origin
  if (!existingBounds) {
    return {
      strategy: 'empty-space',
      position: { x: 100, y: 100 },
    };
  }

  const aspect = calculateAspectRatio(existingBounds);

  // Wide layout (horizontal): prefer bottom placement
  if (aspect > 1.5) {
    return {
      strategy: 'bottom',
      position: placeResearchBottom(existingBounds, { padding }),
    };
  }

  // Tall layout (vertical): prefer right placement
  if (aspect < 0.66) {
    return {
      strategy: 'right',
      position: placeResearchRight(existingBounds, { padding }),
    };
  }

  // Check available space on the right (if viewport provided)
  if (viewport) {
    const spaceOnRight = viewport.width - existingBounds.maxX;
    if (spaceOnRight > 600) {
      return {
        strategy: 'right',
        position: placeResearchRight(existingBounds, { padding }),
      };
    }
  }

  // Default: place bottom
  return {
    strategy: 'bottom',
    position: placeResearchBottom(existingBounds, { padding }),
  };
}
