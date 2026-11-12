// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `beforeunload` orchestration.
 *
 * Drains every persistence queue's trailing tail via keepalive
 * POSTs / PUTs so the in-flight typing / dragging / labeling work
 * the user just triggered isn't lost when they close the tab.
 *
 * Why one consolidated handler instead of N separate listeners:
 *   - Single registration site = single place to reason about
 *     unload semantics (order, guard conditions, retry behavior).
 *   - The structure-save guard (`structureScheduler.cancelPending`
 *     returning `false`) only meaningfully composes with the other
 *     queue states when they live next to each other.
 *
 * The order intentionally matches the persistence "directions":
 *   1. Event buffer (cheapest, fire-and-forget POST per canvas).
 *   2. Per-node content (cheap, one keepalive PUT per dirty node).
 *   3. Preprocess (one keepalive POST per node with a fresh snapshot).
 *   4. Queued structure edits (one keepalive execute request per
 *      unanswered batch, each with the request id it already has, so one
 *      that was on the wire cannot run twice).
 *   5. Structure (one keepalive PUT — only when a debounce was queued,
 *      so closing a clean tab no longer bumps `version` for free).
 *
 * When structure edits are still unsent the handler also asks the browser
 * to confirm leaving: a keepalive request is best effort, and with the
 * network down nothing can be flushed at all.
 */

import type { CanvasEventBuffer } from './eventBuffer';
import type { NodeContentQueue } from './nodeContentQueue';
import type { PreprocessQueue } from './preprocessQueue';
import type { StructureScheduler } from './structureScheduler';

/** Minimal shape of the structure-save action invoked by the handler. */
type SaveCanvasFn = (opts?: {
  keepalive?: boolean;
  force?: boolean;
}) => Promise<void>;

export type UnloadFlushDeps = {
  events: CanvasEventBuffer;
  nodeContent: NodeContentQueue;
  preprocess: PreprocessQueue;
  structure: StructureScheduler;
  /**
   * Lazy getter for the structure-save store action. Lazy because the
   * store factory hasn't run yet at the moment this module is wired
   * (queues are created at module top, the store action is a closure
   * inside `create(...)` further down).
   */
  getSaveCanvas: () => SaveCanvasFn;
  /**
   * `true` when the store holds structural geometry that hasn't been
   * confirmed saved — i.e. a regular PUT is in flight (`isSaving`) or
   * another save is queued behind it (`pendingSave`). Both states are
   * invisible to `structure.cancelPending()` (its debounce timer has
   * already fired), yet the in-flight request is a non-keepalive
   * fetch that the browser aborts on unload. The flush uses this to
   * fire a forced keepalive PUT so that trailing edit isn't lost.
   */
  hasUnsavedStructure: () => boolean;
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
     * where the host has its own close flow (the desktop app).
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
    deps.preprocess.flushKeepalive();
    if (deps.sendQueue?.hasUnsent()) {
      deps.sendQueue.flushKeepalive();
      if (event && deps.sendQueue.warnBeforeLeaving()) {
        // The standard way to ask for the browser's own confirmation.
        event.preventDefault();
        event.returnValue = '';
      }
    }
    // Structure save has three "unsaved" states on unload:
    //   1. A debounce timer is still queued — `cancelPending()`
    //      returns `true`; we cancel it and send the PUT ourselves.
    //   2. A regular PUT is in flight, or a save is queued behind it
    //      (`isSaving` / `pendingSave`) — invisible to the timer, but
    //      the in-flight fetch is non-keepalive and gets aborted by
    //      the browser on unload, so the edit would be lost.
    // Either way, push the latest in-store geometry via a forced
    // keepalive PUT. When none of these hold, the latest structural
    // state is already on disk — skip the PUT so closing a clean tab
    // doesn't bump `version` for free.
    const hadPendingTimer = deps.structure.cancelPending();
    if (hadPendingTimer || deps.hasUnsavedStructure()) {
      void deps
        .getSaveCanvas()({ keepalive: true, force: true })
        .catch(() => undefined);
    }
  };
}
