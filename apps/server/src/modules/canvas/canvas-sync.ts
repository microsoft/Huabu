/**
 * Canvas real-time sync publisher.
 *
 * A minimal in-memory pub/sub keyed by `canvasId`, mirroring the
 * pattern in `external-watcher.ts`. `publishCanvasUpdate` is called from
 * the `POST /:canvasId/execute` route after a batch is persisted; every
 * live SSE subscriber (`GET /:canvasId/sync/stream`) receives the event
 * and replays the deltas locally.
 *
 * Only the out-of-band HTTP `/execute` route publishes here. The
 * built-in agent mutates the canvas in-process via `executeOnServer`
 * directly (not through the HTTP route) and applies its own deltas
 * through the agent SSE tool result, so it deliberately does NOT
 * broadcast — otherwise the initiating tab would receive its own change
 * back over the sync stream and apply it twice (there is no per-client
 * echo filtering).
 */

import type { CanvasSyncEvent } from '@sediment/shared';

type Listener = (event: CanvasSyncEvent) => void;

const listenersByCanvas = new Map<string, Set<Listener>>();

/** Broadcast a sync event to every subscriber of `canvasId`. */
export function publishCanvasUpdate(
  canvasId: string,
  event: CanvasSyncEvent,
): void {
  const set = listenersByCanvas.get(canvasId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* ignore listener errors — one bad subscriber must not stall others */
    }
  }
}

/** Subscribe to sync events for `canvasId`. Returns an unsubscribe fn. */
export function subscribeCanvasUpdates(
  canvasId: string,
  listener: Listener,
): () => void {
  let set = listenersByCanvas.get(canvasId);
  if (!set) {
    set = new Set();
    listenersByCanvas.set(canvasId, set);
  }
  set.add(listener);
  return () => {
    const s = listenersByCanvas.get(canvasId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listenersByCanvas.delete(canvasId);
  };
}
