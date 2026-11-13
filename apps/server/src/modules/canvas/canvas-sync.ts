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

import { AsyncResource } from 'node:async_hooks';

import { recordContentSave } from './content-watermark.js';

import type { CanvasSyncEvent } from '@huabu/shared';

type Listener = (event: CanvasSyncEvent) => void;

const listenersByCanvas = new Map<string, Set<Listener>>();

/**
 * Broadcast a sync event to every subscriber of `canvasId`.
 *
 * An `invalidate` that names nodes is a content save: it is recorded and
 * stamped with its sequence (`contentSeq`) whether or not anyone is
 * listening, so a page that connects later can ask what it missed.
 */
export function publishCanvasUpdate(
  canvasId: string,
  event: CanvasSyncEvent,
): void {
  if (event.type === 'invalidate' && event.data.nodeIds?.length) {
    event = {
      type: 'invalidate',
      data: {
        ...event.data,
        contentSeq: recordContentSave(canvasId, event.data.nodeIds),
      },
    };
  }
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
