// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  /**
   * The artifact storage key — equal to the on-disk filename
   * (`<artifactId><ext>`). The front-end should store **only this key**
   * in `data.src` / `data.coverUrl`. The full URL is reconstructed at
   * render time via `resolveArtifactUrl(key, canvasId)` so the persisted
   * canvas state stays portable across canvas renames and host moves.
   */
  uri: string;
  /** Original upload filename, when known. */
  filename?: string;
  /** Original upload MIME type, when known. */
  mimetype?: string;
}

/** Response for `GET /api/agent/context-tokens/:threadId`. */
export interface ContextTokensResponse {
  /**
   * Tokens the provider reported as `prompt_tokens` on the last LLM
   * call (`AssistantMessage.usage.input + .output`) — i.e. the true
   * size of the conversation context that will be re-submitted on the
   * next turn, including system prompt, tool schemas, role overhead
   * and JSON framing. Returns `0` when no assistant turn exists yet.
   */
  contextTokens: number;
  /** Effective context window of the currently bound model, in tokens. */
  contextWindow: number;
  /**
   * Cumulative USD cost for this thread, summed from
   * `AssistantMessage.usage.cost.total` across all turns. `null` when
   * the provider does not report cost (e.g. self-hosted OSS models).
   */
  cost?: { amount: number; currency: 'USD' } | null;
  /**
   * `true` when `contextTokens` is derived from provider-reported
   * usage; `false` when it is a tokenizer estimate (no assistant turn
   * yet). The ring uses this to decide whether to trust the number.
   */
  fromProvider: boolean;
}

/** Response for `POST /api/agent/stop/:threadId`. */
export interface StopThreadResponse {
  stopped: boolean;
}

/** Response for `POST /api/llm/oauth/logout`. */
export interface OAuthLogoutResponse {
  ok: true;
}
