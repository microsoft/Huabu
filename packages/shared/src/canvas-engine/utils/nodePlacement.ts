// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getNodeDefaultSize, getNodeSize } from './nodeSizes.js';
import {
  createAbsolutePositionGetter,
  indexById,
  type NestableNode,
} from '../container/index.js';

export type NodePlacementSide = 'top' | 'right' | 'bottom' | 'left';

export interface NodePlacementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_GAP = 80;
const NODE_AVOID_GAP = 24;
const MIN_AVOID_DISTANCE = 800;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function avoidOverlap(
  ideal: { x: number; y: number },
  newSize: { width: number; height: number },
  side: NodePlacementSide,
  obstacles: readonly Rect[],
  maxDistance: number,
): { x: number; y: number } {
  const vertical = side === 'left' || side === 'right';
  const step = (vertical ? newSize.height : newSize.width) + NODE_AVOID_GAP;
  const fits = (point: { x: number; y: number }): boolean =>
    !obstacles.some((obstacle) =>
      rectsOverlap(
        { ...point, width: newSize.width, height: newSize.height },
        obstacle,
      ),
    );

  if (fits(ideal)) return ideal;

  const maxSteps = Math.floor(maxDistance / step);
  for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex += 1) {
    for (const direction of [1, -1] as const) {
      const offset = direction * stepIndex * step;
      const point = vertical
        ? { x: ideal.x, y: ideal.y + offset }
        : { x: ideal.x + offset, y: ideal.y };
      if (fits(point)) return point;
    }
  }
  return ideal;
}

export function computeAdjacentNodePlacement({
  nodes,
  source,
  nodeType,
  side,
}: {
  nodes: NestableNode[];
  source: NodePlacementBounds;
  nodeType: string;
  side: NodePlacementSide;
}): { x: number; y: number } {
  const defaultSize = getNodeDefaultSize(nodeType);
  const newSize = {
    width: defaultSize.width || 200,
    height: defaultSize.height || 100,
  };
  let ideal: { x: number; y: number };
  switch (side) {
    case 'top':
      ideal = {
        x: source.x + source.width / 2 - newSize.width / 2,
        y: source.y - newSize.height - NODE_GAP,
      };
      break;
    case 'left':
      ideal = {
        x: source.x - newSize.width - NODE_GAP,
        y: source.y + source.height / 2 - newSize.height / 2,
      };
      break;
    case 'right':
      ideal = {
        x: source.x + source.width + NODE_GAP,
        y: source.y + source.height / 2 - newSize.height / 2,
      };
      break;
    case 'bottom':
      ideal = {
        x: source.x + source.width / 2 - newSize.width / 2,
        y: source.y + source.height + NODE_GAP,
      };
      break;
  }

  const getAbsolutePosition = createAbsolutePositionGetter(indexById(nodes));
  const obstacles: Rect[] = [];
  for (const node of nodes) {
    if (node.type === 'frame') continue;
    const position = getAbsolutePosition(node.id);
    if (!position) continue;
    const measured = getNodeSize(node);
    const fallback = getNodeDefaultSize(node.type ?? '');
    obstacles.push({
      x: position.x,
      y: position.y,
      width: measured.width > 0 ? measured.width : fallback.width || 200,
      height: measured.height > 0 ? measured.height : fallback.height || 100,
    });
  }

  const avoidAxisExtent =
    side === 'left' || side === 'right' ? source.height : source.width;
  return avoidOverlap(
    ideal,
    newSize,
    side,
    obstacles,
    MIN_AVOID_DISTANCE + avoidAxisExtent,
  );
}
