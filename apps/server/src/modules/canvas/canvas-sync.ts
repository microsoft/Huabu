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
 * ALL canvas writes broadcast — the HTTP `/execute` route (browser pages,
 * ACP, headless callers) AND the built-in / question-node agents that
 * mutate in-process via `executeOnServer`. The chat SSE tool result does
 * not apply canvas state, so the initiating tab is a plain receiver. A
 * page is not filtered out of the broadcast: it recognises the update for
 * its own batch by `operationId`.
 */

import { AsyncResource } from 'node:async_hooks';

import type { CanvasSyncEvent } from '@huabu/shared';

/**
 * Who caused an event, for what a subscriber is told depends on it (see
 * `eventForSubscriber` in `caller-principal.ts`). Never on the wire.
 */
export interface CanvasUpdateOrigin {
  principalId: string;
}

type Listener = (event: CanvasSyncEvent, origin?: CanvasUpdateOrigin) => void;

const listenersByCanvas = new Map<string, Set<Listener>>();

/**
 * Broadcast a sync event to every subscriber of `canvasId`.
 *
 * Nothing is kept for a page that is not listening. What such a page missed
 * it learns from storage: the Space version for structure, and the node
 * writes since its content position for content (`SpaceNodes.changes`).
 */
export function publishCanvasUpdate(
  canvasId: string,
  event: CanvasSyncEvent,
  origin?: CanvasUpdateOrigin,
): void {
  const set = listenersByCanvas.get(canvasId);
  if (!set) return;
  for (const fn of set) {
    try {
      if (origin) fn(event, origin);
      else fn(event);
    } catch {
      /* ignore listener errors — one bad subscriber must not stall others */
    }
  }
}

/**
 * Subscribe to sync events for `canvasId`. Returns an unsubscribe fn.
 *
 * The listener runs in its subscriber's async context, not the writer's: an
 * observer in one Workspace reads that Workspace, whoever published.
 */
export function subscribeCanvasUpdates(
  canvasId: string,
  listener: Listener,
): () => void {
  const bound: Listener = AsyncResource.bind(listener);
  let set = listenersByCanvas.get(canvasId);
  if (!set) {
    set = new Set();
    listenersByCanvas.set(canvasId, set);
  }
  set.add(bound);
  return () => {
    const s = listenersByCanvas.get(canvasId);
    if (!s) return;
    s.delete(bound);
    if (s.size === 0) listenersByCanvas.delete(canvasId);
  };
}
