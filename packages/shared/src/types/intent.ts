import type { AgentBaseContext } from './context.js';

// ==================== Intent Recognition ====================

/**
 * A single candidate intent identified by the AI model.
 * `confidence` ranges from 0 to 1.
 */
export interface IntentCandidate {
  /** Human-readable intent label */
  label: string;
  /** Model confidence score (0–1) */
  confidence: number;
  /** Optional short description / rationale */
  description?: string;
}

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
