// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  apiErrorFromResponse,
  getRateLimitRetryAfterSeconds,
} from '@/api/_client';
import { readTypedSSEStream } from '@/api/_sse';
import { canvasSyncStreamUrl } from '@/api/canvasSync';

import type { CanvasSyncEvent } from '@huabu/shared';

type Listener = (event: CanvasSyncEvent) => void;
const subscriptions = new Map<
  string,
  {
    controller: AbortController;
    listeners: Set<Listener>;
    version?: number;
  }
>();

/** Canvas rendering and conversation observation share one transport per Space. */
export function subscribeCanvasSync(
  canvasId: string,
  listener: Listener,
): () => void {
  let subscription = subscriptions.get(canvasId);
  if (!subscription) {
    subscription = { controller: new AbortController(), listeners: new Set() };
    subscriptions.set(canvasId, subscription);
    const current = subscription;
    const { signal } = current.controller;
    void (async () => {
      let delay = 500;
      while (!signal.aborted) {
        let nextDelay = delay;
        try {
          const response = await fetch(canvasSyncStreamUrl(canvasId), {
            signal,
          });
          if (!response.ok)
            throw await apiErrorFromResponse(
              response,
              `Canvas sync failed with HTTP ${response.status}`,
            );
          if (!response.body)
            throw new Error('Canvas sync response has no stream');
          await readTypedSSEStream<CanvasSyncEvent>(
            response,
            (event) => {
              if (signal.aborted) return;
              if (
                event.type !== 'snapshot' &&
                event.type !== 'update' &&
                event.type !== 'invalidate'
              )
                return;
              delay = 500;
              if (event.type !== 'invalidate')
                current.version =
                  event.type === 'snapshot'
                    ? event.data.version
                    : event.data.toVersion;
              for (const receive of current.listeners) {
                try {
                  receive(event);
                } catch (error) {
                  console.error('[canvasSync] subscriber failed', error);
                }
              }
            },
            signal,
            { inactivityTimeoutMs: 45_000 },
          );
          if (!signal.aborted)
            throw new Error('Canvas sync stream ended unexpectedly');
        } catch (error) {
          if (signal.aborted) return;
          const retryAfter = getRateLimitRetryAfterSeconds(error);
          if (retryAfter !== null)
            nextDelay = Math.max(nextDelay, retryAfter * 1000);
          console.warn('[canvasSync] reconnecting after stream failure', error);
        }
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, nextDelay);
          signal.addEventListener('abort', finish, { once: true });
        });
        delay = Math.min(delay * 2, 10_000);
      }
    })();
  }
  const current = subscription;
  current.listeners.add(listener);
  if (current.version !== undefined) {
    queueMicrotask(() => {
      if (current.listeners.has(listener) && current.version !== undefined)
        listener({ type: 'snapshot', data: { version: current.version } });
    });
  }
  return () => {
    if (!current.listeners.delete(listener)) return;
    if (current.listeners.size === 0) {
      current.controller.abort();
      if (subscriptions.get(canvasId) === current)
        subscriptions.delete(canvasId);
    }
  };
}
