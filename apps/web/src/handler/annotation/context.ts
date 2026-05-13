/**
 * Stage 2: Context extraction.
 *
 * For each annotation cluster we collect lightweight wire refs (id +
 * type + label) for nearby nodes / enclosed nodes plus the IDs of
 * nearby edges. Carrying type + label saves the LLM a `read`
 * round-trip on simple gestures (it knows what each id refers to
 * without looking it up); the server enriches each ref into an
 * `AgentNodeRef` (with the pre-computed `nodes/<safeLabel>.md` path)
 * before any prompt rendering.
 *
 * Positions, distances, geometry, and shape inference are still NOT in
 * the payload — the LLM reads gesture shape from the screenshot. It can
 * pull node text via `read`, node layout via `inspect_nodes`, and edge
 * style via `inspect_edges` on demand.
 */

import {
  rectEdgeDistance,
  rectCenter,
  rectsOverlap,
  rectIntersectionArea,
} from '@sediment/shared';

import type {
  AnnotationCluster,
  AnnotationContext,
  CanvasNodeType,
  WireNodeRef,
} from '@sediment/shared';
import type { Rect } from '@sediment/shared';
import type { Edge, Node } from '@xyflow/react';

/** Maximum edge distance (px) to consider a node as "nearby". */
const NEARBY_RADIUS = 300;
/** Maximum number of nearby nodes to include. */
const MAX_NEARBY_NODES = 12;
/** Padding (px) added around the cluster bbox when searching for enclosed nodes. */
const ENCLOSURE_PADDING = 20;
/** Maximum distance (px) for a canvas edge to be considered "nearby the cluster". */
const NEARBY_EDGE_DISTANCE = 50;
/** Maximum number of nearby edges to include. */
const MAX_NEARBY_EDGES = 8;

// ── Helpers ──────────────────────────────────────────────────────

function nodeToRect(node: Node): Rect {
  const w =
    (node.measured?.width ?? (node.style?.width as number | undefined)) || 0;
  const h =
    (node.measured?.height ?? (node.style?.height as number | undefined)) || 0;
  return { x: node.position.x, y: node.position.y, width: w, height: h };
}

/** Squared distance from a point to a finite line segment. */
function pointSegDistSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/** Minimum distance between a line segment and a rectangle (0 if intersecting). */
function segmentRectDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: Rect,
): number {
  const rx1 = rect.x;
  const ry1 = rect.y;
  const rx2 = rect.x + rect.width;
  const ry2 = rect.y + rect.height;

  const aInside = ax >= rx1 && ax <= rx2 && ay >= ry1 && ay <= ry2;
  const bInside = bx >= rx1 && bx <= rx2 && by >= ry1 && by <= ry2;
  if (aInside || bInside) return 0;

  const candidates = [
    pointSegDistSq(rx1, ry1, ax, ay, bx, by),
    pointSegDistSq(rx2, ry1, ax, ay, bx, by),
    pointSegDistSq(rx1, ry2, ax, ay, bx, by),
    pointSegDistSq(rx2, ry2, ax, ay, bx, by),
  ];
  const clampedToRect = (px: number, py: number) => {
    const cx = Math.max(rx1, Math.min(rx2, px));
    const cy = Math.max(ry1, Math.min(ry2, py));
    const ddx = px - cx;
    const ddy = py - cy;
    return ddx * ddx + ddy * ddy;
  };
  candidates.push(clampedToRect(ax, ay), clampedToRect(bx, by));
  return Math.sqrt(Math.min(...candidates));
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Extract refs of canvas nodes / IDs of canvas edges spatially related
 * to the cluster. Each node ref carries id + type + label so the LLM\n * can address nodes without an extra `read`; positions, distances, and\n * shape inference are still NOT included \u2014 the LLM reads those off the\n * screenshot.\n */
export function extractAnnotationContext(
  cluster: AnnotationCluster,
  allNodes: Node[],
  allEdges: Edge[] = [],
): AnnotationContext {
  const clusterRect = cluster.bbox;
  const annotationIds = new Set(cluster.strokeIds);

  // Filter out annotation nodes from candidates. Frame nodes ARE included
  // because the LLM may want to reason about them (e.g. delete a frame).
  const candidateNodes: Array<{ node: Node; rect: Rect; distance: number }> =
    [];
  for (const node of allNodes) {
    if (annotationIds.has(node.id)) continue;
    if (node.type === 'annotation') continue;
    const rect = nodeToRect(node);
    if (rect.width === 0 && rect.height === 0) continue;
    candidateNodes.push({
      node,
      rect,
      distance: rectEdgeDistance(clusterRect, rect),
    });
  }

  // Build a wire ref from a react-flow Node, pulling label out of
  // node.data. Server enriches into `AgentNodeRef` (with
  // `nodes/<safeLabel>.md`) before rendering.
  const toRef = (n: Node): WireNodeRef => {
    const data = (n.data as Record<string, unknown> | undefined) ?? {};
    const label =
      typeof data.label === 'string' && data.label.length > 0
        ? data.label
        : undefined;
    const ref: WireNodeRef = {
      id: n.id,
      type: (n.type ?? 'note') as CanvasNodeType,
    };
    if (label) ref.label = label;
    return ref;
  };

  // Nearby nodes (sorted by edge distance, capped).
  const nearbyNodes = candidateNodes
    .filter((c) => c.distance <= NEARBY_RADIUS)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_NEARBY_NODES)
    .map((c) => toRef(c.node));

  // Enclosed nodes (≥40% of node area inside the padded cluster bbox).
  const paddedRect: Rect = {
    x: clusterRect.x - ENCLOSURE_PADDING,
    y: clusterRect.y - ENCLOSURE_PADDING,
    width: clusterRect.width + ENCLOSURE_PADDING * 2,
    height: clusterRect.height + ENCLOSURE_PADDING * 2,
  };
  const enclosedNodes: WireNodeRef[] = [];
  for (const { node, rect } of candidateNodes) {
    if (!rectsOverlap(paddedRect, rect)) continue;
    const intersection = rectIntersectionArea(paddedRect, rect);
    const area = rect.width * rect.height;
    if (area > 0 && intersection / area >= 0.4) {
      enclosedNodes.push(toRef(node));
    }
  }

  // Nearby edges (segment between source-center and target-center within
  // NEARBY_EDGE_DISTANCE of the cluster bbox).
  const rectById = new Map<string, Rect>();
  for (const c of candidateNodes) rectById.set(c.node.id, c.rect);

  const edgeCandidates: Array<{ id: string; distance: number }> = [];
  for (const edge of allEdges) {
    const src = rectById.get(edge.source);
    const tgt = rectById.get(edge.target);
    if (!src || !tgt) continue;
    const sCenter = rectCenter(src);
    const tCenter = rectCenter(tgt);
    const dist = segmentRectDistance(
      sCenter.x,
      sCenter.y,
      tCenter.x,
      tCenter.y,
      clusterRect,
    );
    if (dist > NEARBY_EDGE_DISTANCE) continue;
    edgeCandidates.push({ id: edge.id, distance: dist });
  }
  const nearbyEdgeIds = edgeCandidates
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_NEARBY_EDGES)
    .map((e) => e.id);

  return {
    cluster,
    nearbyNodes,
    enclosedNodes,
    nearbyEdgeIds,
  };
}
