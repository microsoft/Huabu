// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `beforeunload` orchestration.
 *
 * Drains every persistence queue's trailing tail via keepalive
 * POSTs / PUTs so the in-flight typing / dragging / labeling work
 * the user just triggered isn't lost when they close the tab.
 *
 * Why one consolidated handler instead of N separate listeners: a single
 * registration site is a single place to reason about unload semantics
 * (order, guard conditions, retry behavior).
 *
 * The order intentionally matches the persistence "directions":
 *   1. Event buffer (cheapest, fire-and-forget POST per canvas).
 *   2. Per-node content (cheap, one keepalive PUT per dirty node).
 *   3. Preprocess (one keepalive POST per node with a fresh snapshot).
 *   4. Queued structure edits (one keepalive execute request per
 *      unanswered batch, each with the request id it already has, so one
 *      that was on the wire cannot run twice). This is the whole of the
 *      structure flush: nothing saves the whole Space.
 *
 * When structure edits are still unsent the handler also asks the browser
 * to confirm leaving: a keepalive request is best effort, and with the
 * network down nothing can be flushed at all.
 */

import type { CanvasEventBuffer } from './eventBuffer';
import type { NodeContentQueue } from './nodeContentQueue';

export type UnloadFlushDeps = {
  events: CanvasEventBuffer;
  nodeContent: NodeContentQueue;
  /** Persist the current Canvas's local Preview Workspace layout. */
  flushPreviewWorkspace: () => void;
  /** This page's queued structure edits (the execute send queue). */
  sendQueue?: {
    /** Whether a batch has not been answered by the server yet. */
    hasUnsent: () => boolean;
    /** Send every unanswered batch with `keepalive`. */
    flushKeepalive: () => void;
    /**
     * Whether to ask the browser for its "leave site?" confirmation. False
     * where the host has its own close flow (the desktop app), and when
     * every unanswered batch is a derived report (a measured height or
     * box) rather than an edit the user made: those are flushed, best
     * effort, without asking.
     */
    warnBeforeLeaving: () => boolean;
  };
};

/**
 * Build the `beforeunload` listener. Caller is responsible for
 * registering it via `window.addEventListener('beforeunload', ...)`.
 */
export function createUnloadFlush(
  deps: UnloadFlushDeps,
): (event?: BeforeUnloadEvent) => void {
  return (event) => {
    deps.flushPreviewWorkspace();
    deps.events.flushAllKeepalive();
    deps.nodeContent.flushAllKeepalive();
    if (deps.sendQueue?.hasUnsent()) {
      deps.sendQueue.flushKeepalive();
      if (event && deps.sendQueue.warnBeforeLeaving()) {
        // The standard way to ask for the browser's own confirmation.
        event.preventDefault();
        event.returnValue = '';
      }
    }
  };
}
