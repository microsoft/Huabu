// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// ── Clustering, reading order, arrangement, summary ──────────────
//
// Higher-level spatial reasoning built on geometry + SpatialNode:
//
//   findClusters         single-linkage union-find by edge gap
//   sortByReadingOrder   row-by-row top-to-bottom, left-to-right
//   detectArrangement    classify a set as row / column / grid
//   buildSpatialSummary  compose the above into a per-canvas summary
//
// All server-side: drives the agent's spatial outline + node
// neighbourhood markdown.

import { rectCenter, rectEdgeDistance } from './geometry.js';

import type { SpatialNode } from './proximity.js';

// ── Clustering ────────────────────────────────────────────────────

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

// ── Reading order & arrangement ───────────────────────────────────

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

// ── Spatial summary ───────────────────────────────────────────────

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
