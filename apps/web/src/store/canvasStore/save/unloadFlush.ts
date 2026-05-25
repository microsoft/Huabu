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
 *   4. Structure (one keepalive PUT — only when a debounce was queued,
 *      so closing a clean tab no longer bumps `version` for free).
 */

import type { CanvasEventBuffer } from './eventBuffer';
import type { NodeContentQueue } from './nodeContentQueue';
import type { PreprocessQueue } from './preprocessQueue';
import type { StructureScheduler } from './structureScheduler';

/** Minimal shape of the structure-save action invoked by the handler. */
type SaveCanvasFn = (opts?: { keepalive?: boolean }) => Promise<void>;

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
};

/**
 * Build the `beforeunload` listener. Caller is responsible for
 * registering it via `window.addEventListener('beforeunload', ...)`.
 */
export function createUnloadFlush(deps: UnloadFlushDeps): () => void {
  return () => {
    deps.events.flushAllKeepalive();
    deps.nodeContent.flushAllKeepalive();
    deps.preprocess.flushKeepalive();
    // `cancelPending()` returns `false` when no timer was queued,
    // meaning the latest structural state is already on the wire
    // (or never differed from what's on disk), so we skip the PUT
    // entirely — no more empty diffs bumping `version` on every
    // page close.
    if (deps.structure.cancelPending()) {
      void deps
        .getSaveCanvas()({ keepalive: true })
        .catch(() => undefined);
    }
  };
}
