// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiUrl } from './_client';
import { routes } from './_routes';

import type {
  CanvasPresenceLeaveBody,
  CanvasPresenceReportBody,
} from '@huabu/shared';

/**
 * Outcome of a presence report. Presence is best effort, so a failure is a
 * value rather than a thrown `ApiError`: nothing is shown to the user, and a
 * refused report must not raise the application-wide rate-limit notice.
 */
export type PresenceReportOutcome =
  | { ok: true }
  | { ok: false; retryAfterMs: number | null };

function post(path: string, body: unknown, keepalive = false) {
  return fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive,
  });
}

/** Report what this page is pointing at, selecting, dragging or editing. */
export async function reportCanvasPresence(
  canvasId: string,
  body: CanvasPresenceReportBody,
): Promise<PresenceReportOutcome> {
  try {
    const response = await post(routes.canvasPresence(canvasId), body);
    if (response.ok) return { ok: true };
    const seconds = Number.parseInt(response.headers.get('retry-after') ?? '');
    return {
      ok: false,
      retryAfterMs:
        response.status === 429
          ? (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1_000
          : null,
    };
  } catch {
    return { ok: false, retryAfterMs: null };
  }
}

/**
 * Withdraw this page's presence. Sent `keepalive` so it survives the page
 * closing; if it is lost anyway the server drops the page when its stream
 * closes or its presence expires.
 */
export function leaveCanvasPresence(
  canvasId: string,
  body: CanvasPresenceLeaveBody,
): void {
  void post(routes.canvasPresenceLeave(canvasId), body, true).catch(() => {});
}
