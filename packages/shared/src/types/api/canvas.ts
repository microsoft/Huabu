/**
 * Canvas API Types
 * REST API request/response types for canvas operations.
 *
 * Per docs/api-design.md: schemas are the single source of truth, types
 * derived via `z.infer`.
 */

import { z } from 'zod';

export interface GetCanvasResponse {
  canvasId: string;
  title: string | null;
  version: number;
  state: unknown;
}

/** Body for `PUT /api/canvas/:canvasId`. */
export const putCanvasBodySchema = z.object({
  version: z.number().int().nonnegative(),
  state: z.unknown(),
  title: z.string().min(1).optional(),
});
export type PutCanvasRequest = z.infer<typeof putCanvasBodySchema>;

export interface PutCanvasResponse {
  canvasId: string;
  version: number;
}

export interface DeleteNodeResponse {
  success: boolean;
}

/** Response for DELETE /api/canvas/:canvasId. */
export interface DeleteCanvasResponse {
  success: boolean;
}

/**
 * 409 Conflict body returned by `PUT /api/canvas/:canvasId` when the
 * client's version doesn't match the server's. Shaped like an
 * `ApiErrorBody` so the canonical client (`apiFetch`) surfaces it as a
 * normal `ApiError` and the caller can read `details.serverVersion`.
 */
export interface CanvasVersionMismatchError {
  message: string;
  code: 'CANVAS_VERSION_MISMATCH';
  details: { serverVersion: number };
}

// ─── Rename / conflict errors ─────────────────────────────────────────────

/**
 * Structured 4xx error codes returned from canvas mutation endpoints.
 * Front-end uses the `code` discriminator to pick a UX (toast vs alert
 * vs reload).
 */
export type CanvasErrorCode =
  | 'CANVAS_TITLE_CONFLICT'
  | 'NODE_LABEL_CONFLICT'
  | 'CANVAS_VERSION_CONFLICT'
  | 'INVALID_REQUEST';

/**
 * Body shape for 4xx responses from canvas mutation endpoints.
 *
 * Conflicts return enough context for the client to revert the offending
 * field and tell the user what name they collided with.
 */
export interface CanvasConflictResponse {
  code: CanvasErrorCode;
  message: string;
  /** Existing label / title that the new value collided with. */
  conflictWith?: string;
  /** For node-level conflicts. */
  nodeId?: string;
  /** For version conflicts. */
  serverVersion?: number;
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
 * Querystring for `GET /api/canvas/:canvasId/export`.
 *
 * `includeHistory` arrives as a string ("true" / "false") because all
 * querystring values are strings on the wire. Defaults to true when
 * omitted, mirroring the pre-schema behaviour.
 */
export const exportCanvasQuerySchema = z.object({
  includeHistory: z.enum(['true', 'false']).optional(),
});
export type ExportCanvasQuery = z.infer<typeof exportCanvasQuerySchema>;

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
export const createCanvasBodySchema = z.object({
  title: z.string().min(1).optional(),
});
export type CreateCanvasRequest = z.infer<typeof createCanvasBodySchema>;

/** Response for POST /api/canvas (create a new canvas). */
export interface CreateCanvasResponse {
  canvasId: string;
  title: string | null;
}
