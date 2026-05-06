// ── Spatial reasoning utilities ──────────────────────────────────
//
// Pure functions for spatial queries on canvas nodes.
// Zero dependencies — runs on both frontend and server.

import type { Point } from '../types/canvas/layout.js';

// ================================================================
// Geometry Primitives
// ================================================================

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Center point of a rectangle. */
export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Euclidean distance between two points. */
export function pointDistance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance between the centers of two rectangles. */
export function rectCenterDistance(a: Rect, b: Rect): number {
  return pointDistance(rectCenter(a), rectCenter(b));
}

/**
 * Shortest distance between the edges of two rectangles.
 * Returns 0 when they overlap.
 */
export function rectEdgeDistance(a: Rect, b: Rect): number {
  const dx = Math.max(
    0,
    Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)),
  );
  const dy = Math.max(
    0,
    Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)),
  );
  return Math.sqrt(dx * dx + dy * dy);
}

/** Whether two rectangles overlap (share a positive area). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Area of the intersection of two rectangles (0 when disjoint). */
export function rectIntersectionArea(a: Rect, b: Rect): number {
  const overlapX = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  );
  const overlapY = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  );
  return overlapX * overlapY;
}

// ================================================================
// Direction Classification
// ================================================================

export type CardinalDirection = 'left' | 'right' | 'above' | 'below';

/**
 * The primary cardinal direction of `b` relative to `a`.
 * Uses center-to-center delta; the dominant axis wins.
 */
export function relativeDirection(a: Rect, b: Rect): CardinalDirection {
  const ca = rectCenter(a);
  const cb = rectCenter(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'below' : 'above';
}

// ================================================================
// Spatial Node & Queries
// ================================================================

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

/**
 * Group nodes into spatial layers relative to a target.
 *
 *   P0 — connected (via edges)
 *   P1 — siblings (same parentId)
 *   P2 — nearby (distance-sorted, excluding P0 and P1)
 */
export function buildSpatialLayers<T extends SpatialNode>(
  target: T,
  candidates: T[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  opts?: { nearbyCount?: number },
): {
  connected: ProximityResult<T>[];
  siblings: ProximityResult<T>[];
  nearby: ProximityResult<T>[];
} {
  // Collect directly-connected node IDs.
  const connectedIds = new Set<string>();
  for (const e of edges) {
    if (e.source === target.id) connectedIds.add(e.target);
    if (e.target === target.id) connectedIds.add(e.source);
  }

  // Collect sibling IDs (same parent, excluding connected).
  const siblingIds = new Set<string>();
  if (target.parentId) {
    for (const n of candidates) {
      if (
        n.id !== target.id &&
        n.parentId === target.parentId &&
        !connectedIds.has(n.id)
      ) {
        siblingIds.add(n.id);
      }
    }
  }

  const excludeFromNearby = new Set([...connectedIds, ...siblingIds]);

  const connected = findNearbyNodes(target, candidates, {
    excludeIds: new Set(
      candidates.filter((n) => !connectedIds.has(n.id)).map((n) => n.id),
    ),
  });
  const siblings = findNearbyNodes(target, candidates, {
    excludeIds: new Set(
      candidates.filter((n) => !siblingIds.has(n.id)).map((n) => n.id),
    ),
  });
  const nearby = findNearbyNodes(target, candidates, {
    maxCount: opts?.nearbyCount ?? 10,
    excludeIds: excludeFromNearby,
  });

  return { connected, siblings, nearby };
}

// ================================================================
// Clustering
// ================================================================

/**
 * Partition nodes into clusters using single-linkage clustering.
 * Two nodes are in the same cluster if their edge-to-edge distance
 * is less than `maxGap`.
 *
 * Uses Union-Find for O(n² α(n)) performance.
 */
export function findClusters<T extends SpatialNode>(
  nodes: T[],
  maxGap: number,
): T[][] {
  if (nodes.length === 0) return [];

  // Union-Find
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra) ?? 0;
    const rankB = rank.get(rb) ?? 0;
    if (rankA < rankB) {
      parent.set(ra, rb);
    } else if (rankA > rankB) {
      parent.set(rb, ra);
    } else {
      parent.set(rb, ra);
      rank.set(ra, rankA + 1);
    }
  }

  for (const n of nodes) {
    parent.set(n.id, n.id);
    rank.set(n.id, 0);
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (rectEdgeDistance(nodes[i].rect, nodes[j].rect) < maxGap) {
        union(nodes[i].id, nodes[j].id);
      }
    }
  }

  const groups = new Map<string, T[]>();
  for (const n of nodes) {
    const root = find(n.id);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    group.push(n);
  }

  return [...groups.values()];
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

// ================================================================
// Layout Detection
// ================================================================

/**
 * Sort nodes in reading order: top-to-bottom, then left-to-right.
 * Groups rows by Y proximity (within one average-height tolerance).
 */
export function sortByReadingOrder<T extends SpatialNode>(nodes: T[]): T[] {
  if (nodes.length <= 1) return [...nodes];
  const avgH = nodes.reduce((s, n) => s + n.rect.height, 0) / nodes.length;
  const rowTolerance = avgH * 0.5;

  const sorted = [...nodes].sort((a, b) => a.rect.y - b.rect.y);

  // Group into rows
  const rows: T[][] = [];
  let currentRow: T[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].rect.y - sorted[i - 1].rect.y > rowTolerance) {
      rows.push(currentRow);
      currentRow = [sorted[i]];
    } else {
      currentRow.push(sorted[i]);
    }
  }
  rows.push(currentRow);

  // Sort each row left-to-right
  for (const row of rows) {
    row.sort((a, b) => a.rect.x - b.rect.x);
  }

  return rows.flat();
}

/**
 * Detect the arrangement pattern of a set of nodes.
 * Returns a human-readable description like:
 *   "3 nodes in a horizontal row"
 *   "4 nodes in a 2×2 grid"
 *   "5 nodes in a vertical column"
 *   "6 nodes scattered"
 */
export function detectArrangement(nodes: SpatialNode[]): string {
  const n = nodes.length;
  if (n === 0) return 'empty';
  if (n === 1) return '1 node';

  const avgW = nodes.reduce((s, nd) => s + nd.rect.width, 0) / n;
  const avgH = nodes.reduce((s, nd) => s + nd.rect.height, 0) / n;
  const xTol = avgW * 0.5;
  const yTol = avgH * 0.5;

  // Check horizontal row: all Y centers within tolerance
  const ys = nodes.map((nd) => rectCenter(nd.rect).y);
  const ySpread = Math.max(...ys) - Math.min(...ys);
  if (ySpread < yTol) {
    return `${n} nodes in a horizontal row`;
  }

  // Check vertical column: all X centers within tolerance
  const xs = nodes.map((nd) => rectCenter(nd.rect).x);
  const xSpread = Math.max(...xs) - Math.min(...xs);
  if (xSpread < xTol) {
    return `${n} nodes in a vertical column`;
  }

  // Check grid: cluster by Y into rows, check uniform row lengths
  const sorted = [...nodes].sort(
    (a, b) => rectCenter(a.rect).y - rectCenter(b.rect).y,
  );
  const rows: SpatialNode[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prevY = rectCenter(sorted[i - 1].rect).y;
    const curY = rectCenter(sorted[i].rect).y;
    if (curY - prevY > yTol) {
      rows.push([sorted[i]]);
    } else {
      rows[rows.length - 1].push(sorted[i]);
    }
  }

  if (rows.length >= 2) {
    const colCounts = rows.map((r) => r.length);
    const allSame = colCounts.every((c) => c === colCounts[0]);
    if (allSame && colCounts[0] > 1) {
      return `${n} nodes in a ${rows.length}×${colCounts[0]} grid`;
    }
  }

  return `${n} nodes scattered`;
}

// ================================================================
// Dominant Direction (cluster relative to a target)
// ================================================================

/**
 * The overall cardinal direction of a group of nodes relative to a target.
 * Uses the centroid of all nodes in the group.
 */
export function dominantDirection(
  target: SpatialNode,
  group: SpatialNode[],
): CardinalDirection {
  if (group.length === 0) return 'right';
  const sumX = group.reduce((s, n) => s + rectCenter(n.rect).x, 0);
  const sumY = group.reduce((s, n) => s + rectCenter(n.rect).y, 0);
  const groupCenter: Rect = {
    x: sumX / group.length,
    y: sumY / group.length,
    width: 0,
    height: 0,
  };
  return relativeDirection(target.rect, groupCenter);
}

// ================================================================
// High-Level Builders
// ================================================================

/** A spatial cluster with pre-computed arrangement. */
export interface SpatialCluster {
  /** Frame ID if all nodes in this cluster share a parent frame. */
  frameId?: string;
  /** Frame label (if frameId is set). */
  frameLabel?: string;
  /** Node IDs in reading order. */
  nodeIds: string[];
  /** Human-readable arrangement description. */
  arrangement: string;
}

/** Pre-computed spatial summary of the whole canvas. */
export interface SpatialSummary {
  /** Spatially grouped clusters of nodes. */
  clusters: SpatialCluster[];
  /** IDs of nodes not belonging to any cluster. */
  isolated: string[];
}

/**
 * Build a spatial summary of the entire canvas.
 * Nodes are grouped into clusters by edge proximity, then each
 * cluster's arrangement is detected.
 */
export function buildSpatialSummary(
  nodes: SpatialNode[],
  _edges: ReadonlyArray<{ source: string; target: string }>,
  opts?: { clusterGap?: number },
): SpatialSummary {
  if (nodes.length === 0) return { clusters: [], isolated: [] };

  const gap = opts?.clusterGap ?? 200;
  const rawClusters = findClusters(nodes, gap);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const clusters: SpatialCluster[] = [];
  const isolated: string[] = [];

  for (const group of rawClusters) {
    if (group.length === 1) {
      isolated.push(group[0].id);
      continue;
    }

    const ordered = sortByReadingOrder(group);
    const arrangement = detectArrangement(group);

    // Check if all nodes share a common frame parent.
    const parentIds = new Set(group.map((n) => n.parentId).filter(Boolean));
    let frameId: string | undefined;
    let frameLabel: string | undefined;
    if (parentIds.size === 1) {
      const pid = [...parentIds][0]!;
      const parentNode = nodeById.get(pid);
      if (parentNode) {
        frameId = pid;
        frameLabel = parentNode.label;
      }
    }

    clusters.push({
      frameId,
      frameLabel,
      nodeIds: ordered.map((n) => n.id),
      arrangement,
    });
  }

  return { clusters, isolated };
}

// ================================================================
// Question Node Context Builder
// ================================================================

/** A spatial group of nodes near the question node. */
export interface SpatialGroup {
  /** X offset (px) from reference center to group centroid. Positive = right. */
  dx: number;
  /** Y offset (px) from reference center to group centroid. Positive = below. */
  dy: number;
  /** Human-readable arrangement description. */
  arrangement: string;
  /** Parent frame ID, if all nodes in this group share the same frame. */
  frameId?: string;
  /** Parent frame label (human-readable). */
  frameLabel?: string;
  /** Nodes in reading order with lightweight metadata. */
  nodes: Array<{
    id: string;
    type?: string;
    label?: string;
    snippet?: string;
  }>;
  /**
   * Minimum edge-to-edge distance (px) from the reference to the closest
   * node in this group. Used internally for filtering and sorting.
   * @internal
   */
  _minEdgeDist: number;
}

/**
 * A layer of spatial context.
 * - The innermost layer describes the question node vs. siblings in its frame.
 * - Each outer layer describes the parent frame vs. its surroundings.
 */
export interface SpatialLayer {
  /** If this layer is scoped to a frame, its ID. */
  frameId?: string;
  /** Human-readable frame name (if scoped). */
  frameLabel?: string;
  /** Groups of nodes/entities at this layer, relative to the reference. */
  groups: SpatialGroup[];
  /** Human-readable position description for this layer alone. */
  description: string;
}

/** Full spatial context around a question node. */
export interface QuestionSpatialContext {
  /**
   * Nested layers, from innermost (question node within its frame)
   * to outermost (top-level canvas).
   */
  layers: SpatialLayer[];
  /** Flat list of all groups across layers (for backward compat). */
  groups: SpatialGroup[];
  /** Edges crossing between groups or touching the question node. */
  relevantEdges: Array<{
    source: string;
    target: string;
    sourceLabel?: string;
    targetLabel?: string;
  }>;
  /** Natural-language description of the question node's semantic position. */
  semanticPosition: string;
}

/**
 * Build the spatial context for a question node.
 *
 * Uses a nested approach:
 *   1. If the question is inside a frame, describe its position relative to
 *      sibling nodes in the same frame.
 *   2. Then describe the frame's position relative to entities outside it
 *      (other frames as wholes, loose nodes).
 *   3. Repeat for grandparent frames if nested.
 */
export function buildQuestionNodeContext(
  questionNode: SpatialNode,
  allNodes: SpatialNode[],
  edges: ReadonlyArray<{ source: string; target: string }>,
  nodeSnippets?: Map<string, string>,
  opts?: { maxDistance?: number },
): QuestionSpatialContext {
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const maxDistance = opts?.maxDistance ?? 2000;

  // All content nodes (non-frame, non-self).
  const contentNodes = allNodes.filter(
    (n) => n.id !== questionNode.id && n.type !== 'frame',
  );

  const layers: SpatialLayer[] = [];
  const allGroups: SpatialGroup[] = [];

  // ── Walk from inside-out, starting from the question node ──
  let currentRef: SpatialNode = questionNode;
  let currentFrameId: string | null | undefined = questionNode.parentId;

  while (true) {
    const frame = currentFrameId ? nodeById.get(currentFrameId) : undefined;

    if (frame) {
      // ── Inner layer: currentRef vs siblings inside this frame ──
      const siblings = contentNodes.filter(
        (n) => n.parentId === currentFrameId && n.id !== currentRef.id,
      );
      const siblingGroups = buildGroupsFromNodes(
        currentRef,
        siblings,
        nodeById,
        nodeSnippets,
      ).filter((g) => g._minEdgeDist <= maxDistance);
      const desc = describePositionAmongGroups(currentRef, siblingGroups);
      const layer: SpatialLayer = {
        frameId: frame.id,
        frameLabel: frame.label,
        groups: siblingGroups,
        description: frame.label
          ? `Inside "${frame.label}" frame: ${desc}`
          : `Inside a frame: ${desc}`,
      };
      layers.push(layer);
      allGroups.push(...siblingGroups);

      // Move outward: the frame itself becomes the reference entity.
      currentRef = frame;
      currentFrameId = frame.parentId;
    } else {
      // ── Outermost layer: currentRef vs everything outside ──
      // Collect ancestors to exclude.
      const ancestorIds = new Set<string>();
      {
        let p: string | null | undefined = questionNode.parentId;
        while (p) {
          ancestorIds.add(p);
          p = nodeById.get(p)?.parentId;
        }
      }

      // Helper: true when any ancestor of `n` is in `ancestorIds`.
      const isInsideAncestor = (n: SpatialNode): boolean => {
        let pid = n.parentId;
        while (pid) {
          if (ancestorIds.has(pid)) return true;
          pid = nodeById.get(pid)?.parentId;
        }
        return false;
      };

      // Top-level content nodes: not the question, not an ancestor frame,
      // not a frame, and not nested inside any ancestor frame.
      const topLevelOuter = allNodes.filter(
        (n) =>
          n.id !== questionNode.id &&
          !ancestorIds.has(n.id) &&
          n.type !== 'frame' &&
          !isInsideAncestor(n),
      );

      // Top-level frames that are NOT ancestors (treated as whole entities).
      const outerFrames = allNodes.filter(
        (n) =>
          n.type === 'frame' &&
          n.id !== questionNode.id &&
          !ancestorIds.has(n.id) &&
          !isInsideAncestor(n),
      );

      // Build groups from loose nodes (non-frame, no parent that is an outer frame).
      const outerFrameIds = new Set(outerFrames.map((f) => f.id));
      const looseNodes = topLevelOuter.filter((n) => {
        // Not inside any of the outer frames.
        return !n.parentId || !outerFrameIds.has(n.parentId);
      });

      const outerGroups: SpatialGroup[] = [];

      // Each outer frame becomes a single group.
      for (const f of outerFrames) {
        const refC = rectCenter(currentRef.rect);
        const fC = rectCenter(f.rect);
        const childCount = contentNodes.filter(
          (n) => n.parentId === f.id,
        ).length;
        const fEdgeDist = rectEdgeDistance(currentRef.rect, f.rect);
        outerGroups.push({
          dx: Math.round(fC.x - refC.x),
          dy: Math.round(fC.y - refC.y),
          _minEdgeDist: Math.round(fEdgeDist),
          arrangement: `frame with ${childCount} nodes`,
          frameId: f.id,
          frameLabel: f.label,
          nodes: [
            {
              id: f.id,
              type: 'frame',
              label: f.label,
            },
          ],
        });
      }

      // Cluster loose nodes.
      const looseGroups = buildGroupsFromNodes(
        currentRef,
        looseNodes,
        nodeById,
        nodeSnippets,
      );
      outerGroups.push(...looseGroups);

      // Filter by maxDistance (edge-to-edge) and sort.
      const filteredOuter = outerGroups.filter(
        (g) => g._minEdgeDist <= maxDistance,
      );
      filteredOuter.sort((a, b) => a._minEdgeDist - b._minEdgeDist);

      if (filteredOuter.length > 0) {
        const desc = describePositionAmongGroups(currentRef, filteredOuter);
        layers.push({
          groups: filteredOuter,
          description: layers.length > 0 ? `The frame is ${desc}` : desc,
        });
        allGroups.push(...filteredOuter);
      }

      break; // outermost layer done
    }
  }

  // If no layers at all, the node is isolated.
  if (layers.length === 0 && allGroups.length === 0) {
    return {
      layers: [],
      groups: [],
      relevantEdges: [],
      semanticPosition: 'isolated on canvas',
    };
  }

  // Find edges that involve nearby nodes or touch the question node.
  const nearbyIds = new Set(allGroups.flatMap((g) => g.nodes.map((n) => n.id)));
  nearbyIds.add(questionNode.id);

  const relevantEdges = edges
    .filter((e) => nearbyIds.has(e.source) && nearbyIds.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      sourceLabel: nodeById.get(e.source)?.label,
      targetLabel: nodeById.get(e.target)?.label,
    }));

  // Build combined semantic position from all layers.
  const semanticPosition = layers.map((l) => l.description).join('. ');

  return { layers, groups: allGroups, relevantEdges, semanticPosition };
}

// ── Helpers ──────────────────────────────────────────────────────

/** Build SpatialGroups from a flat list of nodes relative to a reference. */
function buildGroupsFromNodes(
  ref: SpatialNode,
  nodes: SpatialNode[],
  nodeById: Map<string, SpatialNode>,
  nodeSnippets?: Map<string, string>,
): SpatialGroup[] {
  if (nodes.length === 0) return [];

  const clusterGap = 200;

  // Partition by parentId, then cluster within each partition.
  const byParent = new Map<string, SpatialNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? '__none__';
    let arr = byParent.get(key);
    if (!arr) {
      arr = [];
      byParent.set(key, arr);
    }
    arr.push(n);
  }

  const groups: SpatialGroup[] = [];
  for (const [key, partition] of byParent) {
    const parentId = key === '__none__' ? null : key;
    const sub = findClusters(partition, clusterGap);
    for (const cluster of sub) {
      const ordered = sortByReadingOrder(cluster);
      const arrangement = detectArrangement(cluster);

      const offset = groupOffset(ref, cluster);
      const edgeDist = minEdgeDistFromCluster(cluster, ref);
      const group: SpatialGroup = {
        dx: offset.dx,
        dy: offset.dy,
        _minEdgeDist: edgeDist,
        arrangement,
        nodes: ordered.map((n) => ({
          id: n.id,
          type: n.type,
          label: n.label,
          snippet: nodeSnippets?.get(n.id),
        })),
      };

      // Only set frame fields when a parent frame exists.
      if (parentId) {
        const frame = nodeById.get(parentId);
        if (frame) {
          group.frameId = parentId;
          group.frameLabel = frame.label;
        }
      }

      groups.push(group);
    }
  }

  // Sort by edge distance to ref.
  groups.sort((a, b) => a._minEdgeDist - b._minEdgeDist);

  return groups;
}

/** Compute dx/dy offset from ref center to group centroid. */
function groupOffset(
  ref: SpatialNode,
  cluster: SpatialNode[],
): { dx: number; dy: number } {
  const refC = rectCenter(ref.rect);
  const sumX = cluster.reduce((s, n) => s + rectCenter(n.rect).x, 0);
  const sumY = cluster.reduce((s, n) => s + rectCenter(n.rect).y, 0);
  return {
    dx: Math.round(sumX / cluster.length - refC.x),
    dy: Math.round(sumY / cluster.length - refC.y),
  };
}

/** Minimum edge-to-edge distance from any node in the cluster to the ref. */
function minEdgeDistFromCluster(
  cluster: SpatialNode[],
  ref: SpatialNode,
): number {
  let min = Infinity;
  for (const n of cluster) {
    const d = rectEdgeDistance(ref.rect, n.rect);
    if (d < min) min = d;
  }
  return Math.round(min);
}

/** Derive cardinal direction from dx/dy. */
function directionFromOffset(dx: number, dy: number): CardinalDirection {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'below' : 'above';
}

/** Human-readable distance label. */
function distanceLabel(px: number): string {
  if (px <= 0) return 'overlapping';
  if (px <= 50) return 'adjacent';
  if (px <= 200) return 'nearby';
  if (px <= 600) return 'moderate distance';
  return 'far away';
}

/** Describe a single group for use in position text. */
function describeGroup(g: SpatialGroup): string {
  const dist = `dx:${g.dx} dy:${g.dy}, ${distanceLabel(g._minEdgeDist)}`;
  if (g.frameLabel) {
    return `the "${g.frameLabel}" frame (${g.nodes.length} node${g.nodes.length > 1 ? 's' : ''}, ${dist})`;
  }
  if (g.nodes.length === 1 && g.nodes[0]?.label) {
    return `"${g.nodes[0].label}" (${dist})`;
  }
  return `a group of ${g.nodes.length} nodes (${dist})`;
}

/** Describe position of a reference among surrounding groups. */
function describePositionAmongGroups(
  _ref: SpatialNode,
  groups: SpatialGroup[],
): string {
  if (groups.length === 0) return 'no nearby nodes';

  if (groups.length === 1) {
    const g = groups[0];
    const dir = directionFromOffset(g.dx, g.dy);
    return `${dir} of ${describeGroup(g)}`;
  }

  if (groups.length === 2) {
    const [a, b] = groups;
    const dirA = directionFromOffset(a.dx, a.dy);
    const dirB = directionFromOffset(b.dx, b.dy);
    const opposites =
      (dirA === 'left' && dirB === 'right') ||
      (dirA === 'right' && dirB === 'left') ||
      (dirA === 'above' && dirB === 'below') ||
      (dirA === 'below' && dirB === 'above');
    if (opposites) {
      return `between ${describeGroup(a)} (${dirA}) and ${describeGroup(b)} (${dirB})`;
    }
    return `near ${describeGroup(a)} (${dirA}) and ${describeGroup(b)} (${dirB})`;
  }

  const descriptions = groups
    .map((g) => {
      const dir = directionFromOffset(g.dx, g.dy);
      return `${describeGroup(g)} (${dir})`;
    })
    .join(', ');
  return `surrounded by ${groups.length} groups: ${descriptions}`;
}
