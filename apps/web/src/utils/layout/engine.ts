/**
 * @file LayoutEngine — hierarchical recursive layout + incremental placement.
 *
 * Full layout proceeds in two phases:
 *   Phase A (bottom-up): recursively layout frame interiors, determine sizes.
 *   Phase B (top-down):  layout root layer, then assign absolute coordinates.
 *
 * Incremental placement (place) uses a lightweight heuristic that never
 * moves existing nodes — it only positions new (fixed=false) nodes.
 */

import { dagreSolver } from './solvers/dagreSolver';
import { DEFAULT_LAYOUT_OPTIONS } from './types';

import type { LayoutSolver } from './solvers/types';
import type {
  LayoutEdge,
  LayoutGraph,
  LayoutGroup,
  LayoutNode,
  LayoutOptions,
  LayoutResult,
} from './types';

// ── Helpers ────────────────────────────────────────────────────────────

/** Compute a bounding box from positioned nodes. */
function boundingBox(nodes: LayoutNode[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.width);
    maxY = Math.max(maxY, n.position.y + n.height);
  }
  return { minX, minY, maxX, maxY };
}

/** Check if two rectangles overlap (with gap). */
function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  gap: number,
): boolean {
  return (
    ax < bx + bw + gap &&
    ax + aw + gap > bx &&
    ay < by + bh + gap &&
    ay + ah + gap > by
  );
}

// ── Layout Engine ──────────────────────────────────────────────────────

export class LayoutEngine {
  private solver: LayoutSolver;

  constructor(solver?: LayoutSolver) {
    this.solver = solver ?? dagreSolver;
  }

  /**
   * Full layout — repositions all non-fixed nodes using hierarchical recursion.
   */
  layout(
    graph: LayoutGraph,
    options: Partial<LayoutOptions> = {},
  ): LayoutResult {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };

    const positions = new Map<string, { x: number; y: number }>();
    const groupSizes = new Map<string, { width: number; height: number }>();

    // Build lookup structures
    const groupById = new Map(graph.groups.map((g) => [g.id, g]));
    const nodeById = new Map(graph.nodes.map((n) => [n.id, { ...n }]));
    const childToGroup = new Map<string, string>();
    for (const g of graph.groups) {
      for (const childId of g.children) {
        childToGroup.set(childId, g.id);
      }
    }

    // Find root nodes — nodes not inside any group
    const rootNodeIds = new Set(
      graph.nodes.filter((n) => !childToGroup.has(n.id)).map((n) => n.id),
    );

    // Phase A: Bottom-up — layout each group's interior and compute its size.
    // Process groups from leaves to roots (topological order).
    const processedGroups = new Set<string>();

    const layoutGroup = (groupId: string): void => {
      if (processedGroups.has(groupId)) return;
      const group = groupById.get(groupId);
      if (!group) return;

      // Recursively process child groups first
      for (const childId of group.children) {
        if (groupById.has(childId)) {
          layoutGroup(childId);
        }
      }

      // Gather child LayoutNodes for this group
      const childNodes: LayoutNode[] = [];
      for (const childId of group.children) {
        const childGroup = groupById.get(childId);
        if (childGroup) {
          // This child is a sub-group — use its computed size
          const size = groupSizes.get(childId);
          const node = nodeById.get(childId);
          if (size && node) {
            childNodes.push({
              ...node,
              width: size.width,
              height: size.height,
              position: { x: 0, y: 0 },
            });
          }
        } else {
          const node = nodeById.get(childId);
          if (node) {
            childNodes.push({ ...node, position: { x: 0, y: 0 } });
          }
        }
      }

      if (childNodes.length === 0) {
        processedGroups.add(groupId);
        return;
      }

      // Filter edges to only those within this group
      const childSet = new Set(group.children);
      const childEdges = graph.edges.filter(
        (e) => childSet.has(e.source) && childSet.has(e.target),
      );

      // Solve layout for this group's children
      const childPositions = this.solver.solve(childNodes, childEdges, opts);

      // Apply positions to child nodes (these are relative to the group)
      for (const [id, pos] of childPositions) {
        const node = nodeById.get(id);
        if (node) {
          node.position = pos;
        }
      }

      // Compute group bounding box from children's new positions
      const positioned = childNodes.map((cn) => ({
        ...cn,
        position: childPositions.get(cn.id) ?? cn.position,
      }));
      const bbox = boundingBox(positioned);

      // Normalize positions so the top-left child starts at (padding, padding)
      const offsetX = bbox.minX - group.padding;
      const offsetY = bbox.minY - group.padding;
      for (const cn of positioned) {
        const pos = childPositions.get(cn.id);
        if (pos) {
          const normalized = {
            x: pos.x - offsetX,
            y: pos.y - offsetY,
          };
          positions.set(cn.id, normalized);
          const node = nodeById.get(cn.id);
          if (node) node.position = normalized;
        }
      }

      // Group total size
      const groupWidth = bbox.maxX - bbox.minX + group.padding * 2;
      const groupHeight = bbox.maxY - bbox.minY + group.padding * 2;
      groupSizes.set(groupId, { width: groupWidth, height: groupHeight });

      // Update the group node's dimensions in nodeById
      const groupNode = nodeById.get(groupId);
      if (groupNode) {
        groupNode.width = groupWidth;
        groupNode.height = groupHeight;
      }

      processedGroups.add(groupId);
    };

    // Process all groups
    for (const group of graph.groups) {
      layoutGroup(group.id);
    }

    // Phase B: Layout root layer
    const rootNodes: LayoutNode[] = [];
    for (const id of rootNodeIds) {
      const node = nodeById.get(id);
      if (!node) continue;
      // For groups at root level, use their computed size
      const groupSize = groupSizes.get(id);
      if (groupSize) {
        rootNodes.push({
          ...node,
          width: groupSize.width,
          height: groupSize.height,
        });
      } else {
        rootNodes.push({ ...node });
      }
    }

    // Cross-frame edges are promoted to root level — connect the
    // ancestor frame/group that contains each endpoint.
    const getRoot = (nodeId: string): string => {
      let current = nodeId;
      let parent = childToGroup.get(current);
      while (parent) {
        current = parent;
        parent = childToGroup.get(current);
      }
      return current;
    };

    const rootEdges: LayoutEdge[] = [];
    const rootEdgeSet = new Set<string>();
    for (const e of graph.edges) {
      const rootSource = getRoot(e.source);
      const rootTarget = getRoot(e.target);
      if (rootSource === rootTarget) continue; // Intra-group edge, handled above
      if (!rootNodeIds.has(rootSource) || !rootNodeIds.has(rootTarget))
        continue;
      const key = `${rootSource}::${rootTarget}`;
      if (rootEdgeSet.has(key)) continue;
      rootEdgeSet.add(key);
      rootEdges.push({
        source: rootSource,
        target: rootTarget,
        weight: e.weight,
      });
    }

    // Also include edges that were purely between root nodes
    for (const e of graph.edges) {
      if (rootNodeIds.has(e.source) && rootNodeIds.has(e.target)) {
        const key = `${e.source}::${e.target}`;
        if (!rootEdgeSet.has(key)) {
          rootEdgeSet.add(key);
          rootEdges.push(e);
        }
      }
    }

    if (rootNodes.length > 0) {
      const rootPositions = this.solver.solve(rootNodes, rootEdges, opts);

      for (const [id, pos] of rootPositions) {
        if (nodeById.get(id)?.fixed) continue;
        positions.set(id, pos);

        // For groups at root level, offset their children by the group's position
        const group = groupById.get(id);
        if (group) {
          this.offsetGroupChildren(group, pos, positions, groupById);
        }
      }
    }

    return { positions, groupSizes };
  }

  /**
   * Recursively offset all children of a group by the group's absolute position.
   * Children's positions were stored relative to (padding, padding);
   * this adds the group's absolute position so they become absolute.
   */
  private offsetGroupChildren(
    group: LayoutGroup,
    groupPos: { x: number; y: number },
    positions: Map<string, { x: number; y: number }>,
    groupById: Map<string, LayoutGroup>,
  ): void {
    for (const childId of group.children) {
      const childRelPos = positions.get(childId);
      if (!childRelPos) continue;
      // Children's positions are relative to the group — keep them relative
      // because ReactFlow frame children use relative positioning.
      // No offset needed; positions were already set relative in Phase A.

      // But if this child is also a sub-group, recurse
      const childGroup = groupById.get(childId);
      if (childGroup) {
        const childAbsPos = {
          x: groupPos.x + childRelPos.x,
          y: groupPos.y + childRelPos.y,
        };
        this.offsetGroupChildren(childGroup, childAbsPos, positions, groupById);
      }
    }
  }

  /**
   * Incremental placement — only position nodes marked fixed=false.
   * Existing (fixed) nodes are never moved.
   */
  place(
    graph: LayoutGraph,
    options: Partial<LayoutOptions> = {},
  ): LayoutResult {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    const positions = new Map<string, { x: number; y: number }>();
    const groupSizes = new Map<string, { width: number; height: number }>();

    const fixedNodes = graph.nodes.filter((n) => n.fixed);
    const newNodes = graph.nodes.filter((n) => !n.fixed);

    if (newNodes.length === 0) return { positions, groupSizes };

    // For each new node, find a non-overlapping position
    for (const newNode of newNodes) {
      // Find related nodes via edges
      const relatedIds = new Set<string>();
      for (const e of graph.edges) {
        if (
          e.source === newNode.id &&
          graph.nodes.some((n) => n.id === e.target && n.fixed)
        ) {
          relatedIds.add(e.target);
        }
        if (
          e.target === newNode.id &&
          graph.nodes.some((n) => n.id === e.source && n.fixed)
        ) {
          relatedIds.add(e.source);
        }
      }

      let candidateX: number;
      let candidateY: number;

      if (relatedIds.size > 0) {
        // Compute centroid of related nodes
        let sumX = 0;
        let sumY = 0;
        for (const id of relatedIds) {
          const related = graph.nodes.find((n) => n.id === id)!;
          sumX += related.position.x + related.width / 2;
          sumY += related.position.y + related.height / 2;
        }
        const cx = sumX / relatedIds.size;
        const cy = sumY / relatedIds.size;

        // Place below (TB) or to the right (LR) of the centroid
        if (opts.direction === 'LR') {
          candidateX = cx + opts.nodeSpacing;
          candidateY = cy - newNode.height / 2;
        } else {
          candidateX = cx - newNode.width / 2;
          candidateY = cy + opts.nodeSpacing;
        }
      } else {
        // No relations — place at the edge of existing content
        if (fixedNodes.length > 0) {
          const bbox = boundingBox(fixedNodes);
          if (opts.direction === 'LR') {
            candidateX = bbox.maxX + opts.nodeSpacing;
            candidateY = bbox.minY;
          } else {
            candidateX = bbox.minX;
            candidateY = bbox.maxY + opts.nodeSpacing;
          }
        } else {
          candidateX = 0;
          candidateY = 0;
        }
      }

      // Collision detection — spiral outward until no overlap
      const allPlaced = [
        ...fixedNodes,
        ...newNodes
          .filter((n) => positions.has(n.id))
          .map((n) => ({
            ...n,
            position: positions.get(n.id)!,
          })),
      ];

      const step = opts.nodeSpacing;
      let attempts = 0;
      const MAX_ATTEMPTS = 100;

      while (attempts < MAX_ATTEMPTS) {
        const hasOverlap = allPlaced.some((placed) =>
          overlaps(
            candidateX,
            candidateY,
            newNode.width,
            newNode.height,
            placed.position.x,
            placed.position.y,
            placed.width,
            placed.height,
            opts.nodeSpacing / 2,
          ),
        );

        if (!hasOverlap) break;

        // Spiral outward
        attempts++;
        const angle = attempts * 0.5;
        const radius = step * Math.floor(attempts / 6 + 1);
        candidateX += Math.cos(angle) * radius;
        candidateY += Math.sin(angle) * radius;
      }

      positions.set(newNode.id, { x: candidateX, y: candidateY });
    }

    return { positions, groupSizes };
  }
}
