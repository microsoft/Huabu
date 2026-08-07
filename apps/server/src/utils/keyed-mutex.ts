// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Async mutex keyed by an arbitrary value.
 *
 * Calls to `run(key, fn)` with the same key are serialized: each
 * invocation waits for the previous one (for that same key) to settle
 * before running. Calls with different keys do not block each other.
 *
 * Used by the memory module to serialize:
 *   - user memory writes (single shared `user.md` written by
 *     curators from every canvas + chat agents) — key = constant.
 *   - per-canvas op counter mutations (`state.json` read-modify-write)
 *     — key = canvasId.
 *
 * Errors in `fn` do NOT poison successor calls — the next waiter is
 * woken regardless of whether the previous run resolved or rejected.
 */
export function createKeyedMutex<K = string>() {
  // Holds the latest tail promise per key. Older tails are dropped
  // from the map as soon as a successor overwrites the entry, so the
  // map size tracks the number of *currently active* keys, not the
  // historical call volume.
  const tails = new Map<K, Promise<unknown>>();

  return function run<T>(key: K, fn: () => Promise<T> | T): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    // Chain through whether prev resolved or rejected — a failing
    // predecessor must not block the queue.
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
    // Store a swallowed version as the new tail so an unobserved
    // rejection here doesn't trigger Node's unhandledRejection.
    tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };
}
