import type { AgentBaseContext } from './context.js';
import type { Rect } from '../../utils/spatial.js';
import type { CanvasCommand } from '../canvas/command.js';

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

// ==================== Streaming Events ====================
//
// SSE events emitted by `/api/intent/recognize-stream`. Modelled as a
// discriminated union so server emit and client consume share one shape.

/** `event: candidate` — one ranked intent candidate. */
export type IntentCandidateEventData = IntentCandidate;

/** `event: done` — terminator (no payload). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IntentDoneEventData {}

/** `event: error` — recognition failed. */
export interface IntentErrorEventData {
  error: string;
}

export type IntentStreamEvent =
  | { type: 'candidate'; data: IntentCandidateEventData }
  | { type: 'done'; data: IntentDoneEventData }
  | { type: 'error'; data: IntentErrorEventData };

export type IntentStreamEventType = IntentStreamEvent['type'];

/** Canonical event-name constants for the intent SSE stream. */
export const INTENT_SSE_EVENTS = {
  Candidate: 'candidate',
  Done: 'done',
  Error: 'error',
} as const satisfies Record<string, IntentStreamEventType>;

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

// ==================== Annotation Recognition ====================
//
// The pipeline intentionally sends the LLM only IDs + bounding boxes — no
// labels, positions, distances, or shape inference. The LLM is expected to
// call the `get_node_detail` tool when it needs the actual content of a
// referenced node, and to reason about the gesture purely from the
// screenshot. This avoids the false-positive cascades we saw with the old
// rule-based classifier.

/** Structured context for one annotation cluster (IDs only). */
export interface AnnotationClusterContext {
  /** Bounding box of the gesture in flow coordinates. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Number of distinct strokes in the cluster. */
  strokeCount: number;
  /** IDs of canvas nodes near the cluster bbox, ordered by proximity. */
  nearbyNodeIds: string[];
  /** IDs of canvas nodes whose bounding box overlaps the cluster bbox. */
  enclosedNodeIds: string[];
  /** IDs of canvas edges that intersect or are very close to the cluster bbox. */
  nearbyEdgeIds: string[];
}

/**
 * Request body for annotation intent recognition.
 * Carries a screenshot plus minimal cluster context from the client.
 */
export interface AnnotationIntentRequest {
  /** Base64 screenshot of the annotation area (no data: prefix). */
  screenshot: string;
  /** Structured context from the client-side pipeline. */
  clusterContext: AnnotationClusterContext;
  /** Canvas the gesture was drawn on; used by `get_node_detail` lookups. */
  canvasId?: string;
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

/** Context extracted for a clustered set of annotation strokes. */
export interface AnnotationContext {
  cluster: AnnotationCluster;
  /** IDs of canvas nodes near the cluster bbox, ordered by proximity. */
  nearbyNodeIds: string[];
  /** IDs of canvas nodes whose bounding box overlaps the cluster bbox. */
  enclosedNodeIds: string[];
  /** IDs of canvas edges that intersect or are very close to the cluster bbox. */
  nearbyEdgeIds: string[];
}

/** A resolved annotation intent — directly executable canvas commands. */
export interface ResolvedAnnotationIntent {
  /** Atomic batch of canvas commands to execute. */
  commands: CanvasCommand[];
  /** One-sentence explanation of what the user meant. */
  reasoning: string;
  /** The annotation cluster that produced this intent. */
  cluster: AnnotationCluster;
}
