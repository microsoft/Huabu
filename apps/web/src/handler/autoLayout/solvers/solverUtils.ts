/**
 * @file Shared utilities for layout solvers.
 *
 * Functions shared between colaSolver and fcoseSolver to avoid duplication.
 */

import type { LayoutNode } from '../types';

/**
 * Resolve the absolute position of every node by walking up the parent chain.
 *
 * ReactFlow frame children store positions relative to their parent frame.
 * Both the Cola and fCoSE solvers need all positions in a single global
 * coordinate space before running layout.
 *
 * Uses memoisation so each node is resolved at most once, keeping the
 * traversal O(n) even with deeply nested frames.
 */
export function resolveAbsolutePositions(
  nodes: LayoutNode[],
  childToParent: Map<string, string>,
): Map<string, { x: number; y: number }> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const cache = new Map<string, { x: number; y: number }>();

  const resolve = (nodeId: string): { x: number; y: number } => {
    const cached = cache.get(nodeId);
    if (cached) return cached;

    const node = nodeById.get(nodeId);
    if (!node) return { x: 0, y: 0 };

    const parentId = childToParent.get(nodeId);
    if (parentId) {
      const parentAbs = resolve(parentId);
      const abs = {
        x: parentAbs.x + node.position.x,
        y: parentAbs.y + node.position.y,
      };
      cache.set(nodeId, abs);
      return abs;
    }

    // Root-level node — position is already absolute.
    const abs = { ...node.position };
    cache.set(nodeId, abs);
    return abs;
  };

  for (const node of nodes) {
    resolve(node.id);
  }

  return cache;
}
