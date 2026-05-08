/**
 * Preprocessing Pipeline — Wire Types
 *
 * Request/response shapes exchanged between web and server for the unified
 * node preprocessing endpoint. Internal pipeline machinery (capabilities,
 * profiles, full result, diagnostics) lives server-side in
 * `apps/server/src/modules/preprocessing/types.ts`.
 */

import type { CanvasNodeType } from '../canvas/node.js';

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/** Why preprocessing is running. */
export type TriggerReason =
  | 'node_inserted'
  | 'node_updated'
  | 'flush'
  | 'manual'
  | 'repair';

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

/** Options that control how preprocessing runs. */
export interface PreprocessOptions {
  /** Allow LLM calls in the Enrich stage. Default: true. */
  allowLLM?: boolean;
  /** Allow writing to the per-canvas content store. Default: true. */
  allowPersistence?: boolean;
  /** Force reprocessing even if fingerprint matches. Default: false. */
  force?: boolean;
  /** Execution mode. Default: 'background'. */
  mode?: 'interactive' | 'background' | 'manual';
}

/** Request sent to the preprocessing pipeline. */
export interface PreprocessNodeRequest {
  canvasId: string;
  nodeId: string;
  nodeType: CanvasNodeType;
  trigger: TriggerReason;
  /** Current node data snapshot. */
  snapshot: Record<string, unknown>;
  /** Previous node data snapshot (for dirty-field detection on updates). */
  previousSnapshot?: Record<string, unknown>;
  options?: PreprocessOptions;
}

// ---------------------------------------------------------------------------
// Unified HTTP response (POST /:canvasId/nodes/:nodeId/preprocess)
// ---------------------------------------------------------------------------

/**
 * Simplified response returned by the unified preprocess endpoint.
 */
export interface PreprocessNodeResponse {
  nodeId: string;
  success: boolean;
  /** LLM-suggested label from the Enrich stage (for image/frame, or title-derived for ingest types). */
  suggestedLabel?: string;
  /** Structured error description, if any. */
  error?: string;
}
