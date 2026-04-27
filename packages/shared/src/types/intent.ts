import type { AgentBaseContext } from './context.js';

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

// ==================== Annotation Recognition ====================

/** Shape classification result sent from the client. */
export type AnnotationShapeType =
  | 'line'
  | 'circle'
  | 'cross'
  | 'scribble'
  | 'arrow'
  | 'other';

/** A nearby canvas node with spatial information for the LLM. */
export interface AnnotationNearbyNode {
  id: string;
  type: string;
  label?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  distance: number;
  direction: string;
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
  /** IDs of the annotation nodes to analyze. */
  annotationNodeIds: string[];
  /** Structured context from the client-side pipeline. */
  clusterContext: AnnotationClusterContext;
}

/**
 * Request body to log an intent episode outcome.
 */
export interface IntentEpisodeRequest {
  episode: IntentEpisode;
  canvasId?: string;
}
