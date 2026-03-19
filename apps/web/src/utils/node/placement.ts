import { getNodeDefaultSize, type NodeSize } from './factory';

const TEXT_CENTER_OFFSET = { x: 15, y: 12 };
const NOTE_AUTO_HEIGHT_Y_OFFSET = 50;

import type { Point } from '@sediment/shared';

// TODO: double-check
/**
 * Convert a UI placement point (click / drop / paste anchor) into the final
 * top-left position stored on the ReactFlow node.
 */
export function nodePositionFromPlacementPoint(
  point: Point,
  nodeType: string,
  size?: NodeSize | null,
): Point {
  const resolvedSize = size ?? getNodeDefaultSize(nodeType);

  if (!resolvedSize) {
    return {
      x: point.x - TEXT_CENTER_OFFSET.x,
      y: point.y - TEXT_CENTER_OFFSET.y,
    };
  }

  if (typeof resolvedSize.height !== 'number') {
    if (nodeType === 'note') {
      return {
        x: point.x - resolvedSize.width / 2,
        y: point.y - NOTE_AUTO_HEIGHT_Y_OFFSET,
      };
    }

    return {
      x: point.x - TEXT_CENTER_OFFSET.x,
      y: point.y - TEXT_CENTER_OFFSET.y,
    };
  }

  return {
    x: point.x - resolvedSize.width / 2,
    y: point.y - resolvedSize.height / 2,
  };
}
