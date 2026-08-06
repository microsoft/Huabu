// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// ── SpatialNode + proximity queries ──────────────────────────────
//
// `SpatialNode` is the lightweight projection of a canvas node we
// hand to the spatial reasoning layer: id + bounding box + a few
// optional descriptors. Anything beyond geometry (content, ports,
// edge wiring) lives elsewhere and is looked up by id.
//
// Proximity queries answer: "what's near this rect?"
//   - findNearbyNodes: all nodes within a distance budget, sorted
//   - nodesInRect: all nodes whose center falls inside a region

import {
  rectCenter,
  rectCenterDistance,
  rectEdgeDistance,
  relativeDirection,
  type CardinalDirection,
  type Rect,
} from './geometry.js';

export interface SpatialNode {
  id: string;
  rect: Rect;
  type?: string;
  parentId?: string | null;
  label?: string;
}

export interface ProximityResult<T extends SpatialNode = SpatialNode> {
  node: T;
  /** Edge-to-edge distance (0 when overlapping). */
  distance: number;
  /** Center-to-center distance. */
  centerDistance: number;
  /** Direction of this node relative to the target. */
  direction: CardinalDirection;
}

/**
 * Find nodes near `target`, sorted by edge distance.
 * The target itself is excluded from results.
 */
export function findNearbyNodes<T extends SpatialNode>(
  target: T,
  candidates: T[],
  opts?: { maxCount?: number; maxDistance?: number; excludeIds?: Set<string> },
): ProximityResult<T>[] {
  const maxCount = opts?.maxCount ?? Infinity;
  const maxDist = opts?.maxDistance ?? Infinity;
  const excludeIds = opts?.excludeIds;

  const results: ProximityResult<T>[] = [];
  for (const node of candidates) {
    if (node.id === target.id) continue;
    if (excludeIds?.has(node.id)) continue;
    const distance = rectEdgeDistance(target.rect, node.rect);
    if (distance > maxDist) continue;
    results.push({
      node,
      distance,
      centerDistance: rectCenterDistance(target.rect, node.rect),
      direction: relativeDirection(target.rect, node.rect),
    });
  }
  results.sort((a, b) => a.distance - b.distance);
  return maxCount < results.length ? results.slice(0, maxCount) : results;
}

/** All nodes whose center falls within `region`. */
export function nodesInRect<T extends SpatialNode>(
  nodes: T[],
  region: Rect,
): T[] {
  return nodes.filter((n) => {
    const c = rectCenter(n.rect);
    return (
      c.x >= region.x &&
      c.x <= region.x + region.width &&
      c.y >= region.y &&
      c.y <= region.y + region.height
    );
  });
}
