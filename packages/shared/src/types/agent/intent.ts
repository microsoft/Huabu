// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { Rect } from '../../utils/spatial/index.js';
import type { WireNodeRef } from '../api/agent.js';

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
    | {
        type: 'selected';
        chosenIndex: number;
        chosenLabel: string;
        /** Optional execution result written back after operate settles. */
        execution?: IntentExecutionOutcome;
      }
    | { type: 'dismissed' };
}

/** Settled outcome of an executed intent. */
export type IntentExecutionOutcome =
  | { status: 'success'; commandCount?: number }
  | { status: 'error'; error?: string }
  | { status: 'stopped' };

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

// ==================== Sketch Pipeline Types ====================

/**
 * Lightweight wire/clustering view of a sketch node.
 *
 * Distinct from {@link import('../canvas/node.js').SketchStroke}, which
 * is the per-stroke record stored *inside* a node's `data.strokes`
 * array. `SketchNodeRef` describes a whole sketch node and is what the
 * spatial clusterer + AI pipeline operate on. Its `points` field is
 * the **flattened concatenation** of every stroke in the node — the
 * AI side (and the clusterer) only need bounding-box geometry, so
 * stroke boundaries are intentionally collapsed away here.
 */
export interface SketchNodeRef {
  /** Sketch node id. */
  id: string;
  /** Bounding box in flow coordinates. */
  rect: Rect;
  /** All strokes' [x, y, pressure] points concatenated, in node-local coords. */
  points: number[][];
  /** Reference bbox the points were stored against (matches `SketchNodeData.initialSize`). */
  initialSize: { width: number; height: number };
}

/** A cluster of one or more spatially related sketch nodes. */
export interface SketchCluster {
  /** IDs of all sketch nodes in this cluster. */
  strokeIds: string[];
  /** All sketch node refs in the cluster. */
  strokes: SketchNodeRef[];
  /** Merged bounding box of all strokes. */
  bbox: Rect;
}

// ==================== Sketch Recognition ====================
//
// The pipeline ships **bare wire refs** (id + type + label?) for
// nearby / enclosed nodes plus **bare ids** for nearby edges,
// alongside the cluster bbox and stroke count. The server enriches
// each ref into an `AgentNodeRef` (adding the pre-computed
// `nodes/<safeLabel>.md` filename) before rendering the prompt, so
// the LLM never has to apply the safeLabel rule itself — empirically
// it mishandles spaces / punctuation often enough to waste a turn on
// a 404'd `read`.
//
// Positions, distances, geometry, and shape inference are
// deliberately omitted from the wire payload — the LLM reads gesture
// shape from the screenshot, then uses `read` (node text),
// `inspect_nodes` (geometry / style / spatial), and `inspect_edges`
// (style / direction) on demand. Carrying labels saves a `read`
// round-trip on most simple gestures (the model knows what each id
// refers to without looking it up); we still avoid the false-positive
// cascades the old rule-based classifier suffered from because the
// model never sees positions or pre-computed shape guesses.

/** Structured context for one sketch cluster. */
export interface SketchClusterContext {
  /** Bounding box of the gesture in flow coordinates. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Number of distinct strokes in the cluster. */
  strokeCount: number;
  /** Canvas nodes near the cluster bbox, ordered by proximity. */
  nearbyNodes: WireNodeRef[];
  /** Canvas nodes whose bounding box overlaps the cluster bbox. */
  enclosedNodes: WireNodeRef[];
  /** IDs of canvas edges that intersect or are very close to the cluster bbox. */
  nearbyEdgeIds: string[];
}

/**
 * Response body for the one-step sketch → canvas commands endpoint.
 * The sketch agent applies the recognised commands **server-side** (like
 * every other agent path) and attributes the resulting canvas changes to a
 * synthetic `threadId`. The client drives the sketch overlay's
 * Keep / Revert / Preview off that thread's change-review records — it no
 * longer receives or applies the raw commands itself.
 */
export interface SketchCommandResponse {
  /** One-sentence reason describing what the user meant. */
  reasoning: string;
  /**
   * Synthetic thread the recognition's canvas changes are attributed to,
   * so the client can Keep / Revert / Preview them via the standard
   * change-review store. Present whenever recognition ran (even if it made
   * no mutation — the thread simply has no change records then).
   */
  threadId?: string;
}

// ==================== Sketch Pipeline Context ====================

/** Context extracted for a clustered set of sketch strokes. */
export interface SketchContext {
  cluster: SketchCluster;
  /** Canvas nodes near the cluster bbox, ordered by proximity. */
  nearbyNodes: WireNodeRef[];
  /** Canvas nodes whose bounding box overlaps the cluster bbox. */
  enclosedNodes: WireNodeRef[];
  /** IDs of canvas edges that intersect or are very close to the cluster bbox. */
  nearbyEdgeIds: string[];
}

/** A resolved sketch intent — recognition applied server-side. */
export interface ResolvedSketchIntent {
  /** One-sentence explanation of what the user meant. */
  reasoning: string;
  /** Synthetic thread the recognition's canvas changes are attributed to. */
  threadId?: string;
  /** The sketch cluster that produced this intent. */
  cluster: SketchCluster;
}
