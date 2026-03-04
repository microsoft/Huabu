/**
 * Canvas Bounds Calculator
 *
 * Calculates the bounding box of existing canvas nodes to determine
 * where to place new research content.
 */

import type { Bounds, Point } from '@sediment/shared';

interface CanvasNode {
  id: string;
  position: Point;
  measured?: { width?: number; height?: number };
  style?: { width?: unknown; height?: unknown };
  width?: number;
  height?: number;
}

/**
 * Get the width and height of a node
 */
function getNodeSize(node: CanvasNode): { width: number; height: number } {
  // Try measured dimensions first (most accurate)
  if (node.measured?.width && node.measured?.height) {
    return {
      width: node.measured.width,
      height: node.measured.height,
    };
  }

  // Try style dimensions
  const styleWidth =
    typeof node.style?.width === 'number'
      ? node.style.width
      : typeof node.style?.width === 'string'
        ? Number.parseFloat(node.style.width)
        : undefined;

  const styleHeight =
    typeof node.style?.height === 'number'
      ? node.style.height
      : typeof node.style?.height === 'string'
        ? Number.parseFloat(node.style.height)
        : undefined;

  if (
    styleWidth !== undefined &&
    styleHeight !== undefined &&
    Number.isFinite(styleWidth) &&
    Number.isFinite(styleHeight)
  ) {
    return { width: styleWidth, height: styleHeight };
  }

  // Try explicit width/height properties
  if (
    node.width !== undefined &&
    node.height !== undefined &&
    Number.isFinite(node.width) &&
    Number.isFinite(node.height)
  ) {
    return { width: node.width, height: node.height };
  }

  // Default dimensions
  return { width: 200, height: 150 };
}

/**
 * Calculate the bounding box of all nodes on a canvas
 *
 * Returns null if canvas is empty
 */
export function calculateCanvasBounds(nodes: CanvasNode[]): Bounds | null {
  if (nodes.length === 0) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    const { x, y } = node.position;
    const { width, height } = getNodeSize(node);

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Calculate the aspect ratio of a bounding box
 *
 * Returns width / height
 */
export function calculateAspectRatio(bounds: Bounds): number {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  if (height === 0) return Infinity;
  return width / height;
}

/**
 * Check if a point is inside a bounding box (with optional padding)
 */
export function isPointInBounds(
  point: Point,
  bounds: Bounds,
  padding = 0,
): boolean {
  return (
    point.x >= bounds.minX - padding &&
    point.x <= bounds.maxX + padding &&
    point.y >= bounds.minY - padding &&
    point.y <= bounds.maxY + padding
  );
}

/**
 * Expand a bounding box by a padding amount
 */
export function expandBounds(bounds: Bounds, padding: number): Bounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}
