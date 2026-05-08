/**
 * Preprocessing Pipeline — Internal Stage Types
 *
 * These types flow between pipeline stages and are not part of the public API.
 */

import type { CanvasNodeType, TriggerReason } from '@sediment/shared';

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
// Node Content Kind & Profile
// ---------------------------------------------------------------------------

/**
 * Subset of canvas node types that carry extractable content and therefore
 * flow through the full preprocessing pipeline (extract → normalize → ...).
 *
 * Excludes purely visual/structural nodes (image, video, frame, annotation,
 * question) which either skip extraction or have no textual payload.
 */
export type NodeContentKind = 'web' | 'pdf' | 'note' | 'text';

/**
 * Declarative preprocessing profile for a canvas node type.
 * The dispatcher uses this to decide which pipeline stages to execute.
 */
export interface NodePreprocessProfile {
  nodeType: CanvasNodeType;
  contentKind?: NodeContentKind;
  capabilities: Capability[];
  /** Node data fields that, when changed, should trigger preprocessing. */
  watchFields: string[];
}

// ---------------------------------------------------------------------------
// Diagnostics & Full Pipeline Result (server-internal)
// ---------------------------------------------------------------------------

/** Structured diagnostic entry. */
export interface PreprocessDiagnostic {
  code: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  retryable?: boolean;
}

/**
 * Full result returned by the preprocessing pipeline. Server-internal — the
 * HTTP endpoint projects this down to `PreprocessNodeResponse` before returning.
 */
export interface PreprocessNodeResult {
  nodeId: string;
  nodeType: CanvasNodeType;
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
  /** Canvas node id (source identity is canvas-local). */
  nodeId: string;
  title?: string;
  /**
   * Frontmatter-bound metadata bag. Intentionally untyped — historically
   * known keys include `author`, `publishDate`, `siteName`, `image`,
   * `wordCount` (web); `pageCount`, `fileSize`, `createdDate` (pdf);
   * `tags`, `lastEditor` (note); `summary`, `keywords` (LLM-enriched).
   * Persisted as-is into the per-node markdown frontmatter.
   */
  metadata?: Record<string, unknown>;
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
  /** Canvas node id under which content was persisted. */
  nodeId?: string;
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
