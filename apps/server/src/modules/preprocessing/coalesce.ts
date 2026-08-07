// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * In-flight async request coalescing.
 *
 * When several identical async requests arrive while one is still
 * running, they share the single in-flight promise instead of each
 * starting its own run. The map entry is deleted as soon as the
 * promise settles, so this only ever shares work that is genuinely
 * concurrent — it never serves a stale result.
 *
 * Used by {@link PreprocessDispatcher}: when N open tabs each replay the
 * same broadcast delta they all schedule an identical
 * `POST /:canvasId/nodes/:nodeId/preprocess`. Those requests land within
 * a few milliseconds of each other (one SSE fan-out + the same client
 * debounce), while the pipeline itself — web/pdf extract + LLM enrich —
 * takes far longer, so the later requests reliably find the first one
 * still in flight and reuse it. The expensive pipeline therefore runs
 * once regardless of how many tabs are open.
 */
export function coalesceInFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  // `Promise.resolve().then(run)` defers `run()` to a microtask so a
  // synchronous throw inside it becomes a rejection (never escapes this
  // function) and the `.finally` cleanup always fires.
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      // Only evict our own entry: a later identical call that arrived
      // after we settled would have installed a fresh promise.
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}
