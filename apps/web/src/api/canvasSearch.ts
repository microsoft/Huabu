// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Streaming NDJSON client for `POST /api/canvas/:canvasId/search`.
 *
 * Resolves once the stream completes (server emits `done` or closes).
 * Aborting `signal` mid-stream short-circuits both the client read
 * loop and the server-side scan (the route listens for socket close).
 *
 * Each parsed `CanvasSearchEvent` is forwarded to `onEvent` synchronously
 * so the caller can update React state without buffering. We never
 * surface partial JSON lines — incomplete trailing data is held in an
 * internal buffer until the next chunk completes the line.
 */

import { apiUrl } from './_client';
import { routes } from './_routes';

import type { CanvasSearchEvent, CanvasSearchRequest } from '@huabu/shared';

export interface SearchStreamOptions {
  request: CanvasSearchRequest;
  onEvent: (event: CanvasSearchEvent) => void;
  signal?: AbortSignal;
}

export async function streamCanvasSearch(
  canvasId: string,
  { request, onEvent, signal }: SearchStreamOptions,
): Promise<void> {
  const response = await fetch(apiUrl(routes.canvasSearch(canvasId)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    // Drain + release the underlying socket before bailing — otherwise the
    // connection stays half-open until GC, which on Chromium-based
    // Electron leaks file descriptors across rapid retypes.
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `Canvas search failed: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // NDJSON: split on \n; the trailing fragment (if any) is held
      // back until the next chunk lands the closing newline.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as CanvasSearchEvent);
        } catch {
          // Skip malformed lines — server should never produce one,
          // but a transient proxy mishap shouldn't break the loop.
        }
      }
    }
    // Flush any final line that wasn't newline-terminated.
    const tail = buffer.trim();
    if (tail) {
      try {
        onEvent(JSON.parse(tail) as CanvasSearchEvent);
      } catch {
        /* see above */
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
