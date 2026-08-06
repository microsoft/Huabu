// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas real-time sync publisher.
 *
 * A minimal in-memory pub/sub keyed by `canvasId`, mirroring the
 * pattern in `external-watcher.ts`. `publishCanvasUpdate` is called from
 * `executeOnServer` after every persisted batch (and from the revert
 * route); every live SSE subscriber (`GET /:canvasId/sync/stream`)
 * receives the event and replays the deltas locally.
 *
 * ALL canvas writes broadcast — the out-of-band HTTP `/execute` route
 * (ACP / headless) AND the built-in / question-node agents that mutate
 * in-process via `executeOnServer` (C2). The chat SSE tool result no
 * longer applies canvas state, so the initiating tab is a plain receiver
 * that applies its own change once, from this broadcast. There is no
 * per-client echo filtering yet (`clientId` is deferred to P2, needed
 * only once user hand-edits also broadcast).
 */

import type { CanvasSyncEvent } from '@huabu/shared';

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
