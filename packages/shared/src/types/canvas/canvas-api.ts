/**
 * Canvas API Types
 * REST API request/response types for canvas operations
 */

export interface GetCanvasResponse {
  canvasId: string;
  version: number;
  state: unknown;
}

export interface PutCanvasRequest {
  version: number;
  state: unknown;
  title?: string;
}

export interface PutCanvasResponse {
  canvasId: string;
  version: number;
}

export interface CanvasVersionMismatchError {
  message: string;
  serverVersion: number;
}

export interface UpdateCanvasStateParams {
  canvasId: string;
  version: number;
  nodes: unknown[]; // ReactFlow Node type
  edges: unknown[]; // ReactFlow Edge type
}

export interface UpdateCanvasStateResult {
  newVersion: number;
}

// ─── Canvas Export / Import ───────────────────────────────────────────────────

/**
 * A single knowledge source record as it appears inside an export bundle.
 * All fields are plain JSON – binary artifacts are base64-encoded separately.
 */
export interface ExportedSource {
  sourceId: string;
  type: string;
  title: string | null;
  src: string | null;
  content: string;
  contentHash: string;
  metaJson: string | null;
}

/**
 * A binary artifact (e.g. PDF) serialised as base64 for embedding in JSON.
 */
export interface ExportedArtifact {
  /** Bare filename as stored in the artifacts directory, e.g. "abc123.pdf" */
  filename: string;
  /** Base64-encoded file contents */
  data: string;
  mimeType: string;
}

/**
 * The top-level shape of a `.sediment.json` canvas export file.
 */
export interface CanvasExportBundle {
  manifest: {
    /** Semver string used to detect format incompatibilities */
    version: string;
    exportedAt: string;
    canvasId: string;
  };
  /** Raw canvas state (nodes + edges + workspace metadata) */
  canvas: {
    nodes: unknown[];
    edges: unknown[];
    workspaceName?: string;
  };
  /** All knowledge sources referenced by the canvas nodes */
  sources: ExportedSource[];
  /** Binary artifacts embedded as base64 (PDF files, etc.) */
  artifacts: ExportedArtifact[];
}

/** Response returned after a successful import */
export interface ImportCanvasResponse {
  canvasId: string;
  importedSources: number;
  importedArtifacts: number;
}
