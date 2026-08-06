// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Frontend API client for the canvas action log.
 *
 * Mirrors `POST/GET /api/canvas/:canvasId/events` — see
 * `packages/shared/src/types/api/canvas-events.ts` for the wire schemas.
 *
 * The web bundle keeps zod out of the runtime by importing the schema
 * file as `import type` only (`PostCanvasEventsRequest` etc. are pure
 * type aliases derived from `z.infer`).
 */

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  CanvasEventInput,
  CanvasEventRecord,
  GetCanvasEventsResponse,
  PostCanvasEventsRequest,
  PostCanvasEventsResponse,
} from '@huabu/shared';

/**
 * Append a batch of events to the canvas action log.
 *
 * Pass `keepalive: true` for the `beforeunload` flush so the browser
 * keeps the request alive past page tear-down. Beware: keepalive
 * requests are capped at 64 KB body size on most browsers, which
 * matches the server-side limit.
 */
export async function postCanvasEvents(
  canvasId: string,
  events: CanvasEventInput[],
  opts?: { keepalive?: boolean; signal?: AbortSignal },
): Promise<PostCanvasEventsResponse> {
  const body: PostCanvasEventsRequest = { events };
  return apiFetch<PostCanvasEventsResponse>(routes.canvasEvents(canvasId), {
    method: 'POST',
    json: body,
    keepalive: opts?.keepalive ?? false,
    signal: opts?.signal,
    fallbackMessage: 'Failed to upload Space events',
  });
}

/**
 * Read the canvas action log. Defaults to the last 100 records;
 * `since` filters to events with `ts >= since` (Unix ms).
 */
export async function getCanvasEvents(
  canvasId: string,
  params?: { limit?: number; since?: number },
): Promise<CanvasEventRecord[]> {
  const search = new URLSearchParams();
  if (params?.limit != null) search.set('limit', String(params.limit));
  if (params?.since != null) search.set('since', String(params.since));
  const qs = search.toString();
  const url = qs
    ? `${routes.canvasEvents(canvasId)}?${qs}`
    : routes.canvasEvents(canvasId);
  const response = await apiFetch<GetCanvasEventsResponse>(url, {
    fallbackMessage: 'Failed to read Space events',
  });
  return response.events;
}
