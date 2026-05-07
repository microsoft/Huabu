/**
 * Preprocessing Pipeline Types
 *
 * Shared types for the unified node preprocessing system.
 * All canvas node types flow through the same 6-stage pipeline:
 * Input Resolve → Extract → Normalize → Enrich → Persist → Project
 */

import type { CanvasNodeType } from './canvas/node.js';
import type { NodeContentKind } from './node-content.js';

// Re-export for convenience — preprocessing consumers use this alias
// to emphasize the preprocessing-specific semantics.

/** Canvas-side node type (what the node looks like on the canvas). */
export type CanvasNodeKind = CanvasNodeType;

// ---------------------------------------------------------------------------
// Capabilities — organized by pipeline stage
// ---------------------------------------------------------------------------

/** Capabilities that belong to the Input Resolve stage. */
export type InputResolveCapability = 'resolve_input';

/** Capabilities that belong to the Extract stage. */
export type ExtractCapability = 'extract_text' | 'fetch_remote_content';

/** Capabilities that belong to the Normalize stage. */
export type NormalizeCapability =
  | 'compute_fingerprint'
  | 'resolve_title'
  | 'merge_metadata';

/** Capabilities that belong to the Enrich (LLM) stage. */
export type EnrichCapability =
  | 'generate_label'
  | 'generate_summary'
  | 'generate_keywords';

/** Capabilities that belong to the Persist stage. */
export type PersistCapability = 'persist_source';

/** Capabilities that belong to the Project stage. */
export type ProjectCapability = 'build_patch';

/** Union of all preprocessing capabilities. */
export type Capability =
  | InputResolveCapability
  | ExtractCapability
  | NormalizeCapability
  | EnrichCapability
  | PersistCapability
  | ProjectCapability;

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
// Node Preprocess Profile
// ---------------------------------------------------------------------------

/**
 * Declarative preprocessing profile for a canvas node type.
 * The dispatcher uses this to decide which pipeline stages to execute.
 */
export interface NodePreprocessProfile {
  nodeType: CanvasNodeKind;
  contentKind?: NodeContentKind;
  capabilities: Capability[];
  /** Node data fields that, when changed, should trigger preprocessing. */
  watchFields: string[];
}

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

/** Options that control how preprocessing runs. */
export interface PreprocessOptions {
  /** Allow LLM calls in the Enrich stage. Default: true. */
  allowLLM?: boolean;
  /** Allow writing to the knowledge store. Default: true. */
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
  nodeType: CanvasNodeKind;
  trigger: TriggerReason;
  /** Current node data snapshot. */
  snapshot: Record<string, unknown>;
  /** Previous node data snapshot (for dirty-field detection on updates). */
  previousSnapshot?: Record<string, unknown>;
  options?: PreprocessOptions;
}

/** Structured diagnostic entry. */
export interface PreprocessDiagnostic {
  code: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  retryable?: boolean;
}

/** Result returned by the preprocessing pipeline. */
export interface PreprocessNodeResult {
  nodeId: string;
  nodeType: CanvasNodeKind;
  trigger: TriggerReason;
  requestId: string;

  success: boolean;
  status: 'success' | 'partial' | 'error' | 'skipped';

  usedCapabilities: Capability[];

  fingerprints: {
    input: string;
    output?: string;
  };

  extracted?: {
    title?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  };

  enriched?: {
    suggestedLabel?: string;
    summary?: string;
    keywords?: string[];
  };

  persistence?: {
    sourceId?: string;
    contentKind?: NodeContentKind;
    isNew?: boolean;
    contentChanged?: boolean;
    placeholder?: boolean;
  };

  /** Authoritative key-value patch the frontend should apply to node data. */
  patch: Record<string, unknown>;

  diagnostics: PreprocessDiagnostic[];
}

// ---------------------------------------------------------------------------
// Unified HTTP response (POST /:canvasId/nodes/:nodeId/preprocess)
// ---------------------------------------------------------------------------

/**
 * Simplified response returned by the unified preprocess endpoint.
 * Clients use this instead of UpsertNodeResponse / ResolveLabelResponse.
 */
export interface PreprocessNodeResponse {
  nodeId: string;
  success: boolean;
  /** Source ID from the Persist stage (for note/text/web/pdf). */
  sourceId?: string;
  /** LLM-suggested label from the Enrich stage (for image/frame, or title-derived for ingest types). */
  suggestedLabel?: string;
  /** Structured error description, if any. */
  error?: string;
}
