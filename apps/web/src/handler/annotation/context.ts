/**
 * Stage 2b: Context Extraction
 *
 * For each classified annotation cluster, find the nearby canvas nodes
 * and determine spatial relationships (enclosed, endpoint-nearest, etc.).
 *
 * This is the canvas equivalent of "extract covered text" in a PDF
 * annotation system — instead of text spans, we find canvas nodes.
 */

import {
  rectEdgeDistance,
  rectCenter,
  rectsOverlap,
  rectIntersectionArea,
  relativeDirection,
  pointDistance,
} from '@sediment/shared';

import type {
  AnnotationCluster,
  ShapeClassification,
  AnnotationContext,
  AnnotationNearbyNode,
  AnnotationNearbyEdge,
} from '@sediment/shared';
import type { Rect, Point } from '@sediment/shared';
import type { Edge, Node } from '@xyflow/react';

/** Maximum edge distance (px) to consider a node as "nearby". */
const NEARBY_RADIUS = 300;
/** Maximum number of nearby nodes to include. */
const MAX_NEARBY_NODES = 8;
/** Padding (px) added around the cluster bbox when searching for enclosed nodes. */
const ENCLOSURE_PADDING = 20;
/** Maximum distance (px) for a canvas edge to be considered "nearby the cluster". */
const NEARBY_EDGE_DISTANCE = 50;
/** Maximum number of nearby edges to include. */
const MAX_NEARBY_EDGES = 6;

// ── Helpers ──────────────────────────────────────────────────────

/** Extract a Rect from a ReactFlow Node. */
function nodeToRect(node: Node): Rect {
  const w =
    (node.measured?.width ?? (node.style?.width as number | undefined)) || 0;
  const h =
    (node.measured?.height ?? (node.style?.height as number | undefined)) || 0;
  return { x: node.position.x, y: node.position.y, width: w, height: h };
}

/** Build an AnnotationNearbyNode from a Node + distance info. */
function toNearbyInfo(
  node: Node,
  rect: Rect,
  clusterRect: Rect,
): AnnotationNearbyNode {
  return {
    id: node.id,
    type: node.type ?? 'note',
    label: (node.data?.label as string | undefined) ?? undefined,
    position: { x: node.position.x, y: node.position.y },
    size: { width: rect.width, height: rect.height },
    distance: rectEdgeDistance(clusterRect, rect),
    direction: relativeDirection(clusterRect, rect),
  };
}

/** Find the node closest to a specific point. */
function closestNodeToPoint(
  point: Point,
  nodes: Array<{ node: Node; rect: Rect }>,
): AnnotationNearbyNode | undefined {
  let best: { node: Node; rect: Rect; dist: number } | undefined;

  for (const { node, rect } of nodes) {
    const center = rectCenter(rect);
    const d = pointDistance(point, center);
    if (!best || d < best.dist) {
      best = { node, rect, dist: d };
    }
  }

  if (!best) return undefined;
  return toNearbyInfo(best.node, best.rect, {
    x: point.x,
    y: point.y,
    width: 0,
    height: 0,
  });
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

  // Check distance from segment endpoints to closest point on rect, plus
  // distance from rect corners projected onto segment.
  const candidates = [
    pointSegDistSq(rx1, ry1, ax, ay, bx, by),
    pointSegDistSq(rx2, ry1, ax, ay, bx, by),
    pointSegDistSq(rx1, ry2, ax, ay, bx, by),
    pointSegDistSq(rx2, ry2, ax, ay, bx, by),
  ];
  // Distance from segment endpoints to rect corners (clamped distance to rect)
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
 * Extract context for a classified annotation cluster by analysing
 * its spatial relationship with all canvas nodes.
 *
 * @param cluster – The annotation cluster (with merged bbox).
 * @param shape – The shape classification from Stage 2a.
 * @param allNodes – All ReactFlow nodes currently on canvas.
 * @returns Full context including nearby, enclosed, and endpoint nodes.
 */
export function extractAnnotationContext(
  cluster: AnnotationCluster,
  shape: ShapeClassification,
  allNodes: Node[],
  allEdges: Edge[] = [],
): AnnotationContext {
  const clusterRect = cluster.bbox;
  const annotationIds = new Set(cluster.strokeIds);

  // Filter out annotation nodes and frame nodes from candidates
  const candidateNodes: Array<{ node: Node; rect: Rect }> = [];
  for (const node of allNodes) {
    if (annotationIds.has(node.id)) continue;
    if (node.type === 'annotation') continue;
    const rect = nodeToRect(node);
    if (rect.width === 0 && rect.height === 0) continue;
    candidateNodes.push({ node, rect });
  }

  // Nearby nodes: within NEARBY_RADIUS edge distance
  const nearbyNodes: AnnotationNearbyNode[] = [];
  for (const { node, rect } of candidateNodes) {
    const edgeDist = rectEdgeDistance(clusterRect, rect);
    if (edgeDist <= NEARBY_RADIUS) {
      nearbyNodes.push(toNearbyInfo(node, rect, clusterRect));
    }
  }
  nearbyNodes.sort((a, b) => a.distance - b.distance);
  const trimmedNearby = nearbyNodes.slice(0, MAX_NEARBY_NODES);

  // Enclosed nodes: significantly overlapping with the cluster bbox
  const paddedRect: Rect = {
    x: clusterRect.x - ENCLOSURE_PADDING,
    y: clusterRect.y - ENCLOSURE_PADDING,
    width: clusterRect.width + ENCLOSURE_PADDING * 2,
    height: clusterRect.height + ENCLOSURE_PADDING * 2,
  };

  const enclosedNodes: AnnotationNearbyNode[] = [];
  for (const { node, rect } of candidateNodes) {
    if (!rectsOverlap(paddedRect, rect)) continue;
    const intersection = rectIntersectionArea(paddedRect, rect);
    const nodeArea = rect.width * rect.height;
    // Node is "enclosed" if >=40% of its area is inside the cluster bbox
    if (nodeArea > 0 && intersection / nodeArea >= 0.4) {
      enclosedNodes.push(toNearbyInfo(node, rect, clusterRect));
    }
  }

  // For line/arrow shapes: find endpoint-nearest nodes
  let startNode: AnnotationNearbyNode | undefined;
  let endNode: AnnotationNearbyNode | undefined;

  if (
    (shape.type === 'line' || shape.type === 'arrow') &&
    shape.startPoint &&
    shape.endPoint
  ) {
    startNode = closestNodeToPoint(shape.startPoint, candidateNodes);
    endNode = closestNodeToPoint(shape.endPoint, candidateNodes);

    // Avoid assigning the same node to both endpoints
    if (startNode && endNode && startNode.id === endNode.id) {
      // Keep only the closer one
      const startDist = pointDistance(
        shape.startPoint,
        rectCenter({
          x: startNode.position.x,
          y: startNode.position.y,
          width: startNode.size.width,
          height: startNode.size.height,
        }),
      );
      const endDist = pointDistance(
        shape.endPoint,
        rectCenter({
          x: endNode.position.x,
          y: endNode.position.y,
          width: endNode.size.width,
          height: endNode.size.height,
        }),
      );
      if (startDist < endDist) {
        endNode = undefined;
      } else {
        startNode = undefined;
      }
    }
  }

  // Nearby edges: edges whose straight-line (source-center → target-center)
  // intersects the cluster bbox or is within NEARBY_EDGE_DISTANCE of it.
  const nodeById = new Map<string, { node: Node; rect: Rect }>();
  for (const entry of candidateNodes) {
    nodeById.set(entry.node.id, entry);
  }
  const nearbyEdges: AnnotationNearbyEdge[] = [];
  for (const edge of allEdges) {
    const src = nodeById.get(edge.source);
    const tgt = nodeById.get(edge.target);
    if (!src || !tgt) continue;
    const sCenter = rectCenter(src.rect);
    const tCenter = rectCenter(tgt.rect);
    const dist = segmentRectDistance(
      sCenter.x,
      sCenter.y,
      tCenter.x,
      tCenter.y,
      clusterRect,
    );
    if (dist > NEARBY_EDGE_DISTANCE) continue;
    nearbyEdges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceLabel: (src.node.data?.label as string | undefined) ?? undefined,
      targetLabel: (tgt.node.data?.label as string | undefined) ?? undefined,
      distance: dist,
    });
  }
  nearbyEdges.sort((a, b) => a.distance - b.distance);
  const trimmedEdges = nearbyEdges.slice(0, MAX_NEARBY_EDGES);

  return {
    cluster,
    shape,
    nearbyNodes: trimmedNearby,
    enclosedNodes,
    nearbyEdges: trimmedEdges,
    startNode,
    endNode,
  };
}
