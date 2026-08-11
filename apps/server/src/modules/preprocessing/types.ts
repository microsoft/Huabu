// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Preprocessing Pipeline — Internal Stage Types
 *
 * These types flow between pipeline stages and are not part of the public API.
 */

import type {
  CanvasCommitEvent,
  CanvasNodeType,
  MutationAck,
  TriggerReason,
} from '@huabu/shared';

// ---------------------------------------------------------------------------
// Capabilities — organized by pipeline stage
// ---------------------------------------------------------------------------

/** Capabilities that belong to the Input Resolve stage. */
export type InputResolveCapability = 'resolve_input';

/** Capabilities that belong to the Extract stage. */
export type ExtractCapability = 'extract_text' | 'fetch_remote_content';

/** Capabilities that belong to the Normalize stage. */
export type NormalizeCapability = 'resolve_title' | 'merge_metadata';

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
 * Subset of canvas node types that carry extractable or persistable content
 * and therefore flow through (a portion of) the preprocessing pipeline.
 *
 * Includes media nodes (image, video) so they can persist their source
 * artifact and gain a metadata-only sidecar markdown. Excludes purely
 * structural nodes (frame, sketch, question).
 */
export type NodeContentKind =
  | 'web'
  | 'pdf'
  | 'office'
  | 'note'
  | 'text'
  | 'image'
  | 'video';

/**
 * Who authors a node body, and therefore whether writes to it are guarded by
 * the rev-CAS (optimistic concurrency):
 *  - `'authored'` → user-editable in-app; a write must carry the caller's
 *    baseline revision and is rejected when the on-disk body diverged (so a
 *    concurrent tab / device / external edit is never silently clobbered).
 *  - `'derived'` → produced by the pipeline (extraction) or bodyless;
 *    read-only in-app, no CAS (last-write-wins).
 */
export type BodyOwnership = 'authored' | 'derived';

/**
 * Declarative preprocessing profile for a canvas node type.
 * The dispatcher uses this to decide which pipeline stages to execute.
 */
export interface NodePreprocessProfile {
  nodeType: CanvasNodeType;
  contentKind?: NodeContentKind;
  /**
   * See {@link BodyOwnership}. Required on every profile (no default) so a new
   * editable node type cannot silently ship without CAS — a missing value is a
   * compile error, not a data-loss foot-gun. Threaded to the Persist stage's
   * authored-body guard by the dispatcher.
   * See `docs/architecture/node-preprocessing.md` §3 (Node profiles).
   */
  bodyOwnership: BodyOwnership;
  capabilities: Capability[];
  /** Node data fields that, when changed, should trigger preprocessing. */
  watchFields: string[];
  /**
   * Per-capability re-run triggers. A capability listed here is kept in an
   * incremental plan only when one of its trigger fields actually changed;
   * capabilities absent from this map fall back to the profile-wide
   * `watchFields` rule (any dirty field → included). Enrich (LLM) capabilities
   * live here so that e.g. renaming a pdf (title / labelSource dirty) does not
   * re-summarise the whole document — only a real `src` change does. On the
   * first run (no `previousSnapshot`) every watched field counts as changed.
   *
   * Trigger fields must be a subset of {@link watchFields}, otherwise an
   * incremental pass would never observe them as dirty.
   */
  capabilityTriggers?: Partial<Record<Capability, string[]>>;
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

  /**
   * The node disappeared from, or changed type in, the authoritative Space
   * topology while preprocessing was in flight. Callers must treat the
   * result as an acknowledgement-only no-op and apply none of its projections.
   */
  superseded?: true;

  /**
   * Global Space version observed by the final topology guard for a result
   * that did not produce a commit. The web client applies legacy projection
   * fields only while its cursor still equals this version.
   */
  observedVersion?: number;

  /** Exact canonical node revision produced/observed by persistence. */
  recordRevision?: string;
  /** Aggregate commit acknowledgement when Persist attempted a commit. */
  ack?: MutationAck;
  /** Canonical durable publication when Persist reached the commit boundary. */
  commit?: CanvasCommitEvent;

  usedCapabilities: Capability[];

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

/** Conservative incarnation baseline captured before asynchronous work. */
export interface PreprocessExecutionBaseline {
  /** Node type owned by this id in the authoritative Space topology. */
  readonly topologyType: string | null;
  readonly spaceVersion: number | null;
  readonly nodeRecordRevision: string | null;
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
  /**
   * Blob name (`<artifactId><ext>`) this node's bytes live under, when the
   * src is a local artifact rather than a remote or data URL.
   */
  artifactName?: string;
  /**
   * Local path the extract stage can hand to a document loader. Filled in
   * by the pipeline from a blob lease — not by `inputResolve`, which stays
   * pure — and only valid for the duration of the run.
   */
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
  /**
   * Raw payload forwarded from a loader (e.g. the original HTML the web
   * loader fetched). Only present for fresh remote fetches; consumed by
   * the pipeline to write a one-shot snapshot artifact and then
   * discarded — it is never persisted to the node sidecar.
   */
  rawHtml?: string;
  /** True when extraction was skipped (e.g. image, empty note). */
  skipped?: boolean;
}

// ---------------------------------------------------------------------------
// Stage 3 — Normalize
// ---------------------------------------------------------------------------

/** Result produced by the Normalize stage. */
export interface NormalizeResult {
  /** Canvas node id (source identity is canvas-local). */
  nodeId: string;
  /**
   * Display label persisted as `label:` in the node markdown frontmatter.
   * Resolved from the source-document title (HTML <title>, PDF metadata,
   * etc.) and overridden by user/agent-set labels.
   */
  label?: string;
  /**
   * Frontmatter-bound metadata bag. Intentionally untyped — historically
   * known keys include `author`, `publishDate`, `siteName`, `image`,
   * `wordCount` (web); `pageCount`, `fileSize`, `createdDate` (pdf);
   * `tags`, `lastEditor` (note); `summary`, `keywords` (LLM-enriched).
   * Persisted as-is into the per-node markdown frontmatter.
   */
  metadata?: Record<string, unknown>;
  canonicalContent: string;
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
  /**
   * The async result no longer belongs to the current topology (the node was
   * removed or changed type). Project must not expose its stale patch.
   */
  superseded?: boolean;
  /** Exact whole-record revision observed after the Persist decision. */
  recordRevision?: string;
  /** Aggregate commit acknowledgement, including semantic no-ops. */
  ack?: MutationAck;
  /** Canonical durable publication, including semantic no-ops. */
  commit?: CanvasCommitEvent;
  /**
   * Final on-disk label after `writeNode`'s dedup pass — mirrors
   * `RenameResult.label` from `canvas-store.ts`. When another node
   * already owns the desired filename, this is the suffixed form
   * (e.g. `"Huabu (2)"`). Project stage prefers this over the raw
   * extracted / enriched suggestion so the client never momentarily
   * renders the un-deduped base label.
   */
  persistedLabel?: string;
  /**
   * Final on-disk `src` after Persist — the normalized URI for web
   * nodes or the canvas-scoped artifact URL for pdf nodes. Captured
   * so the Project stage can surface it as `patch.src` whenever the
   * server-canonical form differs from the snapshot `src` the client
   * sent; without this round-trip the client's `data.src` would
   * silently disagree with the markdown sidecar until the next
   * canvas reload re-hydrates the field.
   */
  persistedSrc?: string;
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
