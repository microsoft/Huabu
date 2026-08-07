// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Memory op-counter Fastify hook.
 *
 * Single ingestion point for every mutating HTTP request that should
 * count toward the per-canvas op counter. Registered globally in
 * `app.ts`.
 *
 * Two hook stages are used together:
 *
 *   - `onResponse` — for ordinary JSON endpoints. Fires after the
 *     response is sent so we can filter by `reply.statusCode` and
 *     only count successful requests.
 *
 *   - `preHandler` — narrowly scoped to `POST /api/agent`. That
 *     handler immediately calls `reply.hijack()` to take over the
 *     socket and stream SSE, which opts out of the normal Fastify
 *     reply lifecycle and means `onResponse` never fires. We bump
 *     in `preHandler` instead, accepting that we count requests
 *     whose validation later fails. That window is tiny (the
 *     handler validates synchronously) and the failure mode is
 *     "the counter advanced by 1 on a malformed request" — which is
 *     no worse than any other guess about user intent.
 *
 * Replaces the per-route `bumpOpCounter(...)` call that used to live
 * inside the canvas events endpoint. New model: any successful
 * mutating request scoped to a canvas counts as one op, except for
 * `POST /api/canvas/<id>/events` which carries N user actions in its
 * body and is weighted accordingly (so a single autosave flush of
 * five drag events still produces five ops, preserving the
 * "node-level granularity" semantics of the previous design).
 */

import { bumpOpCounter, enqueue as enqueueMemory } from './index.js';

import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
} from 'fastify';

// ─── Method / URL filters ──────────────────────────────────────────────────

/** HTTP methods that represent state-changing user intent. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * URL prefixes the hook ignores entirely. Two classes:
 *
 *   - workspace + LLM config endpoints — not bound to a canvas; even
 *     if they were, configuring an API key is not "working on a
 *     canvas".
 *   - agent helpers (`/stop`, `/stream/...`) — chat lifecycle, not
 *     user authoring. The main `POST /api/agent` is handled by the
 *     dedicated preHandler tap below.
 */
const SKIPPED_PREFIXES = [
  '/api/workspace',
  '/api/llm',
  '/api/agent/stop',
  '/api/agent/stream',
];

// ─── Canvas id extraction ──────────────────────────────────────────────────

/**
 * Pull the canvas id off the request, or null if the request isn't
 * canvas-scoped.
 *
 * Two paths:
 *   - `/api/canvas/<canvasId>/...` — the canvas id is the third path
 *     segment. Covers every endpoint registered under canvas /
 *     artifact / preprocessing.
 *   - `POST /api/agent` — chat / operate / sketch all funnel through
 *     this endpoint; the canvas id rides in the JSON body. Routed
 *     via the preHandler tap (the SSE handler hijacks the reply, so
 *     `onResponse` would never see it).
 */
function extractCanvasIdFromUrl(url: string): string | null {
  const m = /^\/api\/canvas\/([^/?]+)/.exec(url);
  if (m && m[1]) return decodeURIComponent(m[1]);
  return null;
}

function extractCanvasIdFromAgentBody(request: FastifyRequest): string | null {
  const body = request.body as { canvasId?: unknown } | undefined;
  if (body && typeof body.canvasId === 'string' && body.canvasId.length > 0) {
    return body.canvasId;
  }
  return null;
}

// ─── Weight extraction ─────────────────────────────────────────────────────

/**
 * How much this request should bump the counter by.
 *
 * Default is 1 (one HTTP request = one op). The single exception is
 * `POST /api/canvas/<id>/events`, which batches N pre-flushed
 * `RecentAction` records from the client; the body's `events.length`
 * is forwarded so the counter still reflects per-action granularity
 * for the buffered UI-intent stream.
 *
 * Falls back to 1 on a malformed / missing body — over-counting is
 * better than silently dropping.
 */
function extractWeight(request: FastifyRequest): number {
  const url = request.url;
  if (
    request.method === 'POST' &&
    /^\/api\/canvas\/[^/?]+\/events(?:\?|$)/.test(url)
  ) {
    const body = request.body as { events?: unknown } | undefined;
    if (Array.isArray(body?.events)) {
      return body.events.length > 0 ? body.events.length : 1;
    }
  }
  return 1;
}

// ─── Bump impl shared by both hook stages ─────────────────────────────────

function safeBump(
  canvasId: string,
  weight: number,
  url: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  return bumpOpCounter(canvasId, weight)
    .then((shouldRun) => {
      if (shouldRun) enqueueMemory(canvasId, logger);
    })
    .catch((err: unknown) => {
      logger.warn(
        {
          canvasId,
          weight,
          url,
          err: err instanceof Error ? err.message : String(err),
        },
        '[memory] op-counter hook failed (non-fatal)',
      );
    });
}

// ─── Hook ──────────────────────────────────────────────────────────────────

/**
 * Register the op-counter hooks on a Fastify instance.
 *
 * Errors inside `safeBump` are swallowed (warn-logged) so a corrupted
 * `.memory/state.json` cannot break ordinary canvas / chat traffic.
 */
export function registerOpCounterHook(app: FastifyInstance): void {
  // ── Stage 1: onResponse for ordinary endpoints ───────────────────────────
  app.addHook('onResponse', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    if (reply.statusCode < 200 || reply.statusCode >= 400) return;

    const url = request.url;
    if (SKIPPED_PREFIXES.some((p) => url.startsWith(p))) return;

    // POST /api/agent is handled by the preHandler tap below — skip it
    // here so we don't double-count if Fastify decides to fire
    // onResponse for hijacked replies in some future version.
    if (url === '/api/agent' || url.startsWith('/api/agent?')) return;

    const canvasId = extractCanvasIdFromUrl(url);
    if (!canvasId) return;

    // Fire-and-forget: the bump is internally serialized per canvas
    // (see trigger.ts:stateLock), and `safeBump` swallows its own
    // failures. Awaiting here would only delay Fastify's hook chain
    // for a response that has already been sent.
    void safeBump(canvasId, extractWeight(request), url, request.log);
  });

  // ── Stage 2: preHandler for POST /api/agent ─────────────────────────────
  //
  // The agent handler calls `reply.hijack()` to stream SSE, which
  // bypasses the standard reply lifecycle and prevents `onResponse`
  // from firing. We tap `preHandler` instead. Trade-off: we may
  // bump on a request that the handler then rejects with 400 (e.g.
  // zod safeParse fail). That window is small and over-counting is
  // safer than under-counting for the memory worker.
  app.addHook('preHandler', async (request) => {
    if (request.method !== 'POST') return;
    const url = request.url;
    if (url !== '/api/agent' && !url.startsWith('/api/agent?')) return;

    const canvasId = extractCanvasIdFromAgentBody(request);
    if (!canvasId) return;

    // Same fire-and-forget rationale as Stage 1 — adding an `await`
    // here would block the agent request waiting for state.json IO.
    void safeBump(canvasId, 1, url, request.log);
  });
}
