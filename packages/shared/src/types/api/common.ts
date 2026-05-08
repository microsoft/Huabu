/**
 * Shared response/error envelope types used across all REST endpoints.
 *
 * Most routes return JSON bodies on both success and failure. This file
 * defines the canonical shape so the front-end and back-end agree on how
 * to surface errors without each call site reinventing it.
 */

/**
 * Canonical error body for `4xx` and `5xx` responses.
 *
 * - `message` is always a user-facing, stable string suitable for UI display.
 * - `code` is an optional machine-readable identifier (e.g.
 *   `'CANVAS_VERSION_MISMATCH'`).
 * - `details` carries optional structured context (e.g. the conflicting
 *   `serverVersion` for canvas writes).
 */
export interface ApiErrorBody {
  message: string;
  code?: string;
  details?: unknown;
}

/**
 * Discriminated reply type for any JSON route that may return either a
 * success body `T` or the canonical {@link ApiErrorBody} on failure.
 *
 * Use this as the `Reply` generic in Fastify route declarations so that
 * `reply.send(...)` is type-checked for both branches without resorting to
 * `as never` casts on the error path.
 */
export type ApiResult<T> = T | ApiErrorBody;

/** Response for `POST /api/canvas/:canvasId/artifact/:type`. */
export interface ArtifactUploadResponse {
  /** Stable artifact id. */
  id: string;
  /** Relative API path the front-end should store as the artifact URL. */
  uri: string;
  /** Original upload filename, when known. */
  filename?: string;
  /** Original upload MIME type, when known. */
  mimetype?: string;
}

/** Response for `GET /api/agent/context-tokens/:threadId`. */
export interface ContextTokensResponse {
  contextTokens: number;
  contextWindow: number;
}

/** Response for `POST /api/agent/stop/:threadId`. */
export interface StopThreadResponse {
  stopped: boolean;
}

/** Response for `POST /api/intent/episode`. */
export interface IntentEpisodeAck {
  success: boolean;
}

/** Response for `POST /api/llm/oauth/logout`. */
export interface OAuthLogoutResponse {
  ok: true;
}
