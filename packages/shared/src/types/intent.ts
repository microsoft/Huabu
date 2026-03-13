import type { AgentBaseContext } from './context.js';

// ==================== Intent Atomic Actions ====================

/**
 * Atomic operations that the AI can compose into executable sequences.
 * Each action maps 1:1 to a CanvasCommand or store method on the frontend.
 *
 * The AI returns these as part of an intent candidate — the frontend
 * executor walks the array and dispatches each action in order.
 */
export type IntentAction =
  | {
      op: 'ADD_NODE';
      nodeType: 'note' | 'text' | 'web' | 'image' | 'pdf' | 'video' | 'frame';
      label?: string;
      content?: string;
      src?: string;
      /** Position relative to viewport center. Omit for auto-placement. */
      position?: { x: number; y: number };
      width?: number;
      height?: number;
    }
  | { op: 'DELETE_NODES'; nodeIds: string[] }
  | { op: 'CONNECT'; sourceId: string; targetId: string }
  | { op: 'DISCONNECT'; sourceId: string; targetId: string }
  | { op: 'UPDATE_NODE_DATA'; nodeId: string; patch: Record<string, unknown> }
  | { op: 'GROUP_INTO_FRAME'; nodeIds: string[]; frameLabel?: string }
  | { op: 'UNFRAME'; frameId: string }
  | { op: 'MOVE_INTO_FRAME'; nodeId: string; frameId: string }
  | { op: 'MOVE_OUT_OF_FRAME'; nodeId: string }
  | { op: 'SELECT_NODES'; nodeIds: string[] }
  | {
      op: 'ALIGN_NODES';
      direction: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';
    }
  | { op: 'SPREAD_NODES' };

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

/**
 * Request body for the second step: resolve a chosen intent into actions.
 */
export interface ResolveActionsRequest {
  canvasContext: AgentBaseContext;
  /** The intent label chosen by the user (may be a custom user-typed intent) */
  chosenIntent: string;
}

/**
 * Response with the resolved action list for a chosen intent.
 */
export interface ResolveActionsResponse {
  actions: IntentAction[];
}

/**
 * Request body to log an intent episode outcome.
 */
export interface IntentEpisodeRequest {
  episode: IntentEpisode;
}
