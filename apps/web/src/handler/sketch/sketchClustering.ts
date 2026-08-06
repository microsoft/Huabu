/**
 * Stage 1: Stroke Clustering
 *
 * Groups sketch nodes into spatial clusters using single-linkage
 * agglomerative clustering on bounding-box edge distance.
 *
 * Strokes that are spatially close belong to the same "gesture" and
 * should be interpreted together. Strokes far apart are independent
 * sketches that get separate intent resolution.
 */

import { rectEdgeDistance } from '@sediment/shared';

import type { SketchNodeRef, SketchCluster } from '@sediment/shared';
import type { Rect } from '@sediment/shared';

/**
 * Maximum edge-to-edge distance (px in flow coordinates) for two
 * strokes to be merged into the same cluster.
 */
const CLUSTER_DISTANCE_THRESHOLD = 200;

/** Merge two bounding boxes into the minimum enclosing rect. */
function mergeRects(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Cluster sketch strokes using Union-Find with single-linkage distance.
 *
 * Complexity: O(n²) pairwise distance — fine for the expected <20 strokes.
 */
export function clusterSketches(
  strokes: SketchNodeRef[],
  threshold = CLUSTER_DISTANCE_THRESHOLD,
): SketchCluster[] {
  if (strokes.length === 0) return [];
  if (strokes.length === 1) {
    return [
      {
        strokeIds: [strokes[0].id],
        strokes: [strokes[0]],
        bbox: strokes[0].rect,
      },
    ];
  }

  // Union-Find
  const parent = strokes.map((_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // path compression
      i = parent[i];
    }
    return i;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Pairwise merge when distance < threshold
  for (let i = 0; i < strokes.length; i++) {
    for (let j = i + 1; j < strokes.length; j++) {
      const dist = rectEdgeDistance(strokes[i].rect, strokes[j].rect);
      if (dist <= threshold) {
        union(i, j);
      }
    }
  }

  // Build clusters from Union-Find groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < strokes.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) {
      group.push(i);
    } else {
      groups.set(root, [i]);
    }
  }

  const clusters: SketchCluster[] = [];
  for (const indices of groups.values()) {
    const clusterStrokes = indices.map((i) => strokes[i]);
    let bbox = clusterStrokes[0].rect;
    for (let k = 1; k < clusterStrokes.length; k++) {
      bbox = mergeRects(bbox, clusterStrokes[k].rect);
    }
    clusters.push({
      strokeIds: clusterStrokes.map((s) => s.id),
      strokes: clusterStrokes,
      bbox,
    });
  }

  return clusters;
}
