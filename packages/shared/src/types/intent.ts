import type { CanvasCommand } from './canvas/command.js';
import type { AgentBaseContext } from './context.js';
import type { CardinalDirection, Rect } from '../utils/spatial.js';

// ==================== Intent Recognition ====================

/**
 * A single candidate intent identified by the AI model.
 */
export interface IntentCandidate {
  /** Human-readable intent label */
  label: string;
  /** Optional short description / rationale */
  description?: string;
}

// ==================== Intent Episode Logging ====================

/**
 * Records the user's interaction with a single intent recognition session.
 * Stored server-side for preference learning.
 */
export interface IntentEpisode {
  id: string;
  timestamp: number;
  /** Serialized context fingerprint for similarity matching */
  contextSummary: string;
  /** All candidates that were offered */
  candidates: IntentCandidate[];
  /** What the user did */
  outcome:
    | { type: 'selected'; chosenIndex: number; chosenLabel: string }
    | { type: 'dismissed' };
}

// ==================== Request / Response ====================

/**
 * Request body sent from the frontend to trigger intent recognition.
 */
export interface IntentRequest {
  /** The lightweight canvas snapshot used for context-aware analysis */
  canvasContext: AgentBaseContext;
}

/**
 * Response returned by the backend after intent recognition.
 */
export interface IntentResponse {
  /** Ordered list of candidate intents (highest confidence first) */
  intentCandidates: IntentCandidate[];
}

// ==================== Annotation Pipeline Types ====================

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

// ==================== Annotation Recognition ====================

/** Shape classification result sent from the client. */
export type AnnotationShapeType =
  | 'line'
  | 'circle'
  | 'cross'
  | 'scribble'
  | 'arrow'
  | 'other';

/** A nearby canvas node with spatial information. */
export interface AnnotationNearbyNode {
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

/** A nearby canvas edge with endpoint summaries for the LLM. */
export interface AnnotationNearbyEdge {
  id: string;
  source: string;
  target: string;
  /** Optional human-readable labels for endpoints. */
  sourceLabel?: string;
  targetLabel?: string;
  /** Edge-to-cluster distance (0 if intersecting). */
  distance: number;
}

/** Structured context for one annotation cluster. */
export interface AnnotationClusterContext {
  /** Geometric shape classification. */
  shapeType: AnnotationShapeType;
  /** Classification confidence 0–1. */
  shapeConfidence: number;
  /** Center of the cluster bounding box. */
  position: { x: number; y: number };
  /** Nearby canvas nodes sorted by distance. */
  nearbyNodes: AnnotationNearbyNode[];
  /** Nodes enclosed by (overlapping with) the cluster area. */
  enclosedNodes: AnnotationNearbyNode[];
  /** Edges that intersect or are very close to the cluster bbox. */
  nearbyEdges: AnnotationNearbyEdge[];
  /** For line/arrow: node closest to the start point. */
  startNode?: AnnotationNearbyNode;
  /** For line/arrow: node closest to the end point. */
  endNode?: AnnotationNearbyNode;
}

/**
 * Request body for annotation intent recognition (LLM fallback path).
 * Carries a cropped screenshot PLUS structured context from the client-side
 * classification pipeline, so the LLM has both visual and semantic signals.
 */
export interface AnnotationIntentRequest {
  /** Base64 screenshot of the annotation area (no data: prefix). */
  screenshot: string;
  /** Structured context from the client-side pipeline. */
  clusterContext: AnnotationClusterContext;
}

/**
 * Response body for the one-step annotation → canvas commands endpoint.
 * The LLM reasons about the user's intent and emits the executable command
 * batch directly — no separate intent label, no operate-agent roundtrip.
 */
export interface AnnotationCommandResponse {
  /** One-sentence reason describing what the user meant. */
  reasoning: string;
  /** Atomic batch of canvas commands to execute. */
  commands: CanvasCommand[];
}

/**
 * Request body to log an intent episode outcome.
 */
export interface IntentEpisodeRequest {
  episode: IntentEpisode;
  canvasId?: string;
}

// ==================== Annotation Pipeline Context ====================

/** Context extracted for a classified cluster. */
export interface AnnotationContext {
  cluster: AnnotationCluster;
  shape: ShapeClassification;
  /** Nearby canvas nodes sorted by distance. */
  nearbyNodes: AnnotationNearbyNode[];
  /** Nodes whose bounding box overlaps/is enclosed by the cluster bbox. */
  enclosedNodes: AnnotationNearbyNode[];
  /** Edges that intersect or are very close to the cluster bbox. */
  nearbyEdges: AnnotationNearbyEdge[];
  /** For line/arrow: the node closest to the start point. */
  startNode?: AnnotationNearbyNode;
  /** For line/arrow: the node closest to the end point. */
  endNode?: AnnotationNearbyNode;
}

/** A resolved annotation intent — directly executable canvas commands. */
export interface ResolvedAnnotationIntent {
  /** Atomic batch of canvas commands to execute. */
  commands: CanvasCommand[];
  /** Which resolution path was used. */
  source: 'rule' | 'llm';
  /** One-sentence explanation of what the user meant. */
  reasoning: string;
  /** The annotation cluster that produced this intent. */
  cluster: AnnotationCluster;
}
