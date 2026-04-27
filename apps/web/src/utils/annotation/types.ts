/**
 * Types for the three-stage annotation intent pipeline.
 *
 * Stage 1: Stroke Clustering — group nearby annotations into clusters
 * Stage 2: Shape Classification + Context Extraction — classify each cluster's shape and find nearby nodes
 * Stage 3: Intent Resolution — rule-based fast path or LLM fallback
 */

import type { Rect, CardinalDirection } from '@sediment/shared';

// ── Stage 1: Clustering ──────────────────────────────────────────

/** Lightweight representation of an annotation node for clustering. */
export interface AnnotationStroke {
  id: string;
  /** Bounding box in flow coordinates. */
  rect: Rect;
  /** Raw [x, y, pressure] points in local node coordinates. */
  points: number[][];
  /** Original bounding box size when the stroke was created. */
  initialSize: { width: number; height: number };
}

/** A cluster of one or more spatially related annotation strokes. */
export interface AnnotationCluster {
  /** IDs of all annotation nodes in this cluster. */
  strokeIds: string[];
  /** All strokes in the cluster. */
  strokes: AnnotationStroke[];
  /** Merged bounding box of all strokes. */
  bbox: Rect;
}

// ── Stage 2: Classification + Context ────────────────────────────

/** Geometric shape classification for an annotation cluster. */
export type AnnotationShapeType =
  | 'line'
  | 'circle'
  | 'cross'
  | 'scribble'
  | 'arrow'
  | 'other';

/** Result of shape classification for a single cluster. */
export interface ShapeClassification {
  type: AnnotationShapeType;
  /** 0–1 confidence in the classification. */
  confidence: number;
  /** For line/arrow: start point in flow coordinates. */
  startPoint?: { x: number; y: number };
  /** For line/arrow: end point in flow coordinates. */
  endPoint?: { x: number; y: number };
}

/** A nearby canvas node with spatial relationship info. */
export interface NearbyNodeInfo {
  id: string;
  type: string;
  label?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  /** Edge-to-edge distance from the cluster bbox. */
  distance: number;
  /** Direction relative to the cluster center. */
  direction: CardinalDirection;
}

/** Context extracted for a classified cluster. */
export interface AnnotationContext {
  cluster: AnnotationCluster;
  shape: ShapeClassification;
  /** Nearby canvas nodes sorted by distance. */
  nearbyNodes: NearbyNodeInfo[];
  /** Nodes whose bounding box overlaps/is enclosed by the cluster bbox. */
  enclosedNodes: NearbyNodeInfo[];
  /** For line/arrow: the node closest to the start point. */
  startNode?: NearbyNodeInfo;
  /** For line/arrow: the node closest to the end point. */
  endNode?: NearbyNodeInfo;
}

// ── Stage 3: Resolved Intent ─────────────────────────────────────

/** A resolved annotation intent ready for execution. */
export interface ResolvedAnnotationIntent {
  /** Human-readable label for the operate agent. */
  label: string;
  /** Which resolution path was used. */
  source: 'rule' | 'llm';
  /** The annotation cluster that produced this intent. */
  cluster: AnnotationCluster;
  /** Position to pass to the operate agent (center of the cluster). */
  position: { x: number; y: number };
}
