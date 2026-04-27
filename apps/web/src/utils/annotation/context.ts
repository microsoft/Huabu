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
  NearbyNodeInfo,
} from './types';
import type { Rect, Point } from '@sediment/shared';
import type { Node } from '@xyflow/react';

/** Maximum edge distance (px) to consider a node as "nearby". */
const NEARBY_RADIUS = 300;
/** Maximum number of nearby nodes to include. */
const MAX_NEARBY_NODES = 8;
/** Padding (px) added around the cluster bbox when searching for enclosed nodes. */
const ENCLOSURE_PADDING = 20;

// ── Helpers ──────────────────────────────────────────────────────

/** Extract a Rect from a ReactFlow Node. */
function nodeToRect(node: Node): Rect {
  const w =
    (node.measured?.width ?? (node.style?.width as number | undefined)) || 0;
  const h =
    (node.measured?.height ?? (node.style?.height as number | undefined)) || 0;
  return { x: node.position.x, y: node.position.y, width: w, height: h };
}

/** Build a NearbyNodeInfo from a Node + distance info. */
function toNearbyInfo(
  node: Node,
  rect: Rect,
  clusterRect: Rect,
): NearbyNodeInfo {
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
): NearbyNodeInfo | undefined {
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
  const nearbyNodes: NearbyNodeInfo[] = [];
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

  const enclosedNodes: NearbyNodeInfo[] = [];
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
  let startNode: NearbyNodeInfo | undefined;
  let endNode: NearbyNodeInfo | undefined;

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

  return {
    cluster,
    shape,
    nearbyNodes: trimmedNearby,
    enclosedNodes,
    startNode,
    endNode,
  };
}
