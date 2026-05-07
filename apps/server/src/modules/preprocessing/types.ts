/**
 * Preprocessing Pipeline — Internal Stage Types
 *
 * These types flow between pipeline stages and are not part of the public API.
 */

import type { NodeContentMetadata } from '@sediment/shared';

// ---------------------------------------------------------------------------
// Stage 1 — Input Resolve
// ---------------------------------------------------------------------------

/** Canonical input produced by the Input Resolve stage. */
export interface ResolvedInput {
  /** The id of the node being processed. */
  nodeId: string;

  /** Node type that was resolved. */
  nodeType: string;

  // Text-based nodes (note, text)
  content?: string;

  // URI-based nodes (web)
  normalizedUri?: string;
  prefetchedContent?: string;

  // Artifact-based nodes (pdf)
  filePath?: string;
  artifactUri?: string;

  // Media nodes (image)
  imageSrc?: string;

  // Structural nodes (frame)
  childLabels?: string[];

  // Passthrough fields
  title?: string;
  labelSource?: string;
  existingSourceId?: string;
}

// ---------------------------------------------------------------------------
// Stage 2 — Extract
// ---------------------------------------------------------------------------

/** Result produced by the Extract stage. */
export interface ExtractResult {
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  /** True when extraction was skipped (e.g. image, empty note). */
  skipped?: boolean;
}

// ---------------------------------------------------------------------------
// Stage 3 — Normalize
// ---------------------------------------------------------------------------

/** Result produced by the Normalize stage. */
export interface NormalizeResult {
  contentHash: string;
  sourceId: string;
  title?: string;
  metadata?: NodeContentMetadata;
  canonicalContent: string;
  inputFingerprint: string;
}

// ---------------------------------------------------------------------------
// Stage 4 — Enrich
// ---------------------------------------------------------------------------

/** Result produced by the Enrich stage. */
export interface EnrichResult {
  suggestedLabel?: string;
  summary?: string;
  keywords?: string[];
  /** True when enrichment was skipped (e.g. LLM disabled). */
  skipped?: boolean;
}

// ---------------------------------------------------------------------------
// Stage 5 — Persist
// ---------------------------------------------------------------------------

/** Result produced by the Persist stage. */
export interface PersistResult {
  sourceId?: string;
  isNew?: boolean;
  contentChanged?: boolean;
  placeholder?: boolean;
  /** True when persistence was skipped (e.g. image node). */
  skipped?: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline Context
// ---------------------------------------------------------------------------

/** Mutable context passed through the pipeline stages. */
export interface PipelineContext {
  resolved?: ResolvedInput;
  extracted?: ExtractResult;
  normalized?: NormalizeResult;
  enriched?: EnrichResult;
  persisted?: PersistResult;
}
