/**
 * Knowledge Source Types
 * Node ingestion and knowledge base storage
 */

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
