/**
 * Layout Service
 *
 * Central service for calculating canvas layouts during research.
 * Coordinates placement strategies and provides a unified interface.
 */
// TODO: This is a very early version focused on research node placement.
import { autoSelectPlacement } from './strategies/auto-placement.js';
import { placeResearchBottom } from './strategies/bottom-placement.js';
import { placeResearchRight } from './strategies/right-placement.js';

import type {
  CalculateLayoutParams,
  LayoutResult,
  PlacementStrategy,
  Point,
} from '@sediment/shared';

// Re-export for convenience
export { calculateCanvasBounds } from './bounds.calculator.js';
export { placeResearchRight } from './strategies/right-placement.js';
export { placeResearchBottom } from './strategies/bottom-placement.js';
export { autoSelectPlacement } from './strategies/auto-placement.js';

/**
 * Calculate layout for new research nodes
 *
 * @param params - Layout calculation parameters
 * @returns Layout result with starting position
 */
export function calculateLayout(params: CalculateLayoutParams): LayoutResult {
  const { existingBounds, placementStrategy, padding = 200 } = params;

  let startPosition: Point;
  let selectedStrategy: PlacementStrategy = placementStrategy;

  // Handle auto strategy
  if (placementStrategy === 'auto') {
    const result = autoSelectPlacement(existingBounds ?? null, { padding });
    startPosition = result.position;
    selectedStrategy = result.strategy;
  }
  // Handle explicit strategies
  else if (!existingBounds) {
    // Empty canvas
    startPosition = { x: 100, y: 100 };
  } else {
    switch (placementStrategy) {
      case 'right':
        startPosition = placeResearchRight(existingBounds, { padding });
        break;
      case 'bottom':
        startPosition = placeResearchBottom(existingBounds, { padding });
        break;
      case 'empty-space':
        // TODO: Implement empty space detection
        // For now, fallback to bottom
        startPosition = placeResearchBottom(existingBounds, { padding });
        break;
      default:
        startPosition = placeResearchBottom(existingBounds, { padding });
    }
  }

  console.log('[calculateLayout] Selected strategy:', {
    requested: placementStrategy,
    selected: selectedStrategy,
    startPosition,
  });

  return { startPosition };
}

/**
 * Generate hierarchical positions for multiple nodes
 *
 * Arranges nodes in a hierarchical layout:
 * - Thinking nodes at the top
 * - Source nodes in the middle (multiple rows if needed)
 * - Synthesis nodes at the bottom
 *
 * @param startPosition - Starting position from calculateLayout
 * @param nodeTypes - Array of node types in order
 * @param spacing - Spacing between nodes
 * @returns Array of positions
 */
export function generateHierarchicalPositions(
  startPosition: Point,
  nodeTypes: Array<'thinking' | 'source' | 'synthesis'>,
  spacing = { x: 300, y: 200 },
): Point[] {
  const positions: Point[] = [];

  // Group by type
  const thinking = nodeTypes
    .map((type, i) => ({ type, index: i }))
    .filter((n) => n.type === 'thinking');
  const sources = nodeTypes
    .map((type, i) => ({ type, index: i }))
    .filter((n) => n.type === 'source');
  const synthesis = nodeTypes
    .map((type, i) => ({ type, index: i }))
    .filter((n) => n.type === 'synthesis');

  let currentY = startPosition.y;

  // Layer 1: Thinking nodes (horizontal)
  thinking.forEach((node, i) => {
    positions[node.index] = {
      x: startPosition.x + i * spacing.x,
      y: currentY,
    };
  });
  if (thinking.length > 0) currentY += spacing.y;

  // Layer 2: Source nodes (grid, 3 per row)
  const sourcesPerRow = 3;
  sources.forEach((node, i) => {
    const row = Math.floor(i / sourcesPerRow);
    const col = i % sourcesPerRow;
    positions[node.index] = {
      x: startPosition.x + col * spacing.x,
      y: currentY + row * spacing.y,
    };
  });
  if (sources.length > 0) {
    const rows = Math.ceil(sources.length / sourcesPerRow);
    currentY += rows * spacing.y;
  }

  // Layer 3: Synthesis nodes (horizontal)
  synthesis.forEach((node, i) => {
    positions[node.index] = {
      x: startPosition.x + i * spacing.x,
      y: currentY,
    };
  });

  return positions;
}
