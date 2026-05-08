/**
 * Canvas API Types
 * REST API request/response types for canvas operations
 */

export interface GetCanvasResponse {
  canvasId: string;
  title: string | null;
  version: number;
  state: unknown;
}

export interface PutCanvasRequest {
  version: number;
  title?: string;
  state: unknown;
}

export interface PutCanvasResponse {
  canvasId: string;
  version: number;
}

export interface DeleteNodeResponse {
  success: boolean;
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
 * Response returned after a successful import.
 * The server allocates a fresh canvas id and restores the bundle in place.
 */
export interface ImportCanvasResponse {
  canvasId: string;
}

// ─── Canvas List / Create ─────────────────────────────────────────────────────

/** Summary of a single canvas returned by the list endpoint. */
export interface CanvasSummary {
  canvasId: string;
  title: string | null;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Response for GET /api/canvas (list all canvases). */
export interface ListCanvasesResponse {
  canvases: CanvasSummary[];
}

/** Request body for POST /api/canvas (create a new canvas). */
export interface CreateCanvasRequest {
  title?: string;
}

/** Response for POST /api/canvas (create a new canvas). */
export interface CreateCanvasResponse {
  canvasId: string;
  title: string | null;
}
