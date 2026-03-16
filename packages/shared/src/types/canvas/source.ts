/**
 * Knowledge Source Types
 * Node ingestion and knowledge base storage
 */

import type { CanvasNodeType } from './node.js';

/**
 * Node ingestion request types
 */

export interface UpsertNodeRequest {
  type: Exclude<CanvasNodeType, 'frame'>; // All node types except 'frame'
  title?: string;
  content?: string;
  src?: string;
  /**
   * Existing source ID from a previous ingestion.
   * When provided the server will update the existing source
   * instead of creating a new one.
   */
  sourceId?: string;
}

export interface UpsertNodeResponse {
  nodeId: string;
  sourceId: string;
  success: boolean;
  /**
   * Optional server-suggested label derived from ingested content (e.g. web page title, PDF title).
   * The client may choose to apply it only when the current label is empty or still a placeholder.
   */
  suggestedLabel?: string;
  error?: string;
}

export interface DeleteNodeResponse {
  success: boolean;
}

// ---------------------------------------------------------------------------
// Resolve Label — LLM-powered semantic label generation
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/canvas/resolve-label.
 * Discriminated union: the server picks a strategy based on `type`.
 */
export type ResolveLabelRequest =
  | { type: 'image'; src: string }
  | { type: 'frame'; childLabels: string[] };

export interface ResolveLabelResponse {
  /** LLM-generated semantic label, or undefined when generation failed. */
  suggestedLabel?: string;
}
