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

// ─── Per-node content endpoints ───────────────────────────────────────────

/**
 * Body for `PUT /api/canvas/:canvasId/nodes/:nodeId/content`.
 *
 * Carries the per-node fields that are persisted into the markdown sidecar
 * (`nodes/<safe(label)>.md`). Every field except `nodeType` is optional so
 * a callsite can write only the bits that actually changed; missing
 * fields are read from the existing `.md` and round-tripped untouched.
 *
 * See `docs/node-content-api-split.md`.
 */
export const putNodeContentBodySchema = z.object({
  /** Node type (`note` / `text` / `web` / `pdf` / `image` / `video` / `frame` / `question`). */
  nodeType: z.string().min(1),
  /** Markdown body. Only meaningful for text-bearing types (note/text/web/pdf). */
  content: z.string().optional(),
  /** Display label / filename stem. `null` clears any explicit label. */
  label: z.string().nullable().optional(),
  /**
   * Provenance of the label. `'user'` triggers strict-rename mode on the
   * server (409 on collision); `'agent'` / `'auto'` use lazy dedupe.
   */
  labelSource: z.enum(['user', 'auto', 'agent']).optional(),
  /** External URL or `artifacts/<file>` reference (source-backed nodes only). */
  src: z.string().optional(),
  /** AI-derived one-line summary persisted to frontmatter. */
  summary: z.string().optional(),
  /** AI-derived keyword list persisted to frontmatter. */
  keywords: z.array(z.string()).optional(),
  /** Opaque pass-through frontmatter blob (e.g. AI provenance markers). */
  provenance: z.unknown().optional(),
});
export type PutNodeContentRequest = z.infer<typeof putNodeContentBodySchema>;

/**
 * Response for `PUT /api/canvas/:canvasId/nodes/:nodeId/content`.
 *
 * `label` is the value actually persisted to the markdown frontmatter
 * (and the on-disk filename). For agent-sourced labels it may differ
 * from the request `label` because the server appends a ` (N)` suffix
 * to dedupe; the client must patch its in-memory `data.label` with this
 * value to stay aligned with the canonical `.md`.
 */
export interface PutNodeContentResponse {
  nodeId: string;
  label: string | null;
  /** True when the markdown file could not be read back after write. */
  contentMissing?: boolean;
  /** True when the referenced artifact file is missing on disk. */
  artifactMissing?: boolean;
}

/**
 * Response for `GET /api/canvas/:canvasId/nodes/:nodeId/content`.
 *
 * When `contentMissing` is true the markdown sidecar has not been written
 * yet (or was deleted out-of-band); `content` is empty and `label` is
 * `null` in that case.
 */
export interface GetNodeContentResponse {
  nodeId: string;
  type: string;
  label: string | null;
  labelSource?: 'user' | 'auto' | 'agent';
  src?: string;
  content: string;
  summary?: string;
  keywords?: string[];
  contentMissing?: boolean;
  artifactMissing?: boolean;
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
