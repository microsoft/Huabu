// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Generic per-key debouncer primitive.
 *
 * Used by the per-node save queues (`preprocessQueue`,
 * `nodeContentQueue`) where each key independently coalesces rapid
 * writes into a single trailing-edge fire.
 *
 * NOT used by the structure scheduler (single global timer, no key
 * dimension) or the event buffer (accumulating, not debounced).
 *
 * The work itself is captured in the closure passed to
 * {@link PerKeyDebouncer.schedule} — the debouncer does not store
 * payloads, just the timer handle. Callers that need late-binding
 * (read latest store snapshot at fire time) should fetch state from
 * inside the closure, not at schedule time.
 */

/**
 * Public shape returned by {@link createPerKeyDebouncer}.
 */
export type PerKeyDebouncer<K> = {
  /**
   * Start (or reset) a debounce for `key`. If a previous timer for
   * the same key is pending, it is cancelled and replaced — only the
   * most recently scheduled `fn` will run.
   */
  schedule(key: K, fn: () => void): void;

  /**
   * Cancel the pending timer for `key`, if any. Returns `true` when a
   * timer was actually cancelled, `false` when nothing was pending.
   */
  cancel(key: K): boolean;

  /**
   * Cancel every pending timer without firing any of them. Returns
   * the snapshot of keys that were pending. Used by `switchCanvas`
   * to abandon in-flight work for the outgoing canvas.
   */
  cancelAll(): K[];

  /** Snapshot of currently pending keys (order is insertion order). */
  pendingKeys(): K[];

  /** Whether a timer is currently pending for `key`. */
  has(key: K): boolean;
};

/**
 * Build a {@link PerKeyDebouncer}. The same delay applies to every
 * key.
 */
export function createPerKeyDebouncer<K>(delayMs: number): PerKeyDebouncer<K> {
  const pending = new Map<K, ReturnType<typeof setTimeout>>();

  return {
    schedule(key, fn) {
      const existing = pending.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        // Remove ourselves from the map first so the callback sees a
        // clean "not pending" state if it inspects the debouncer.
        pending.delete(key);
        fn();
      }, delayMs);
      pending.set(key, timer);
    },

    cancel(key) {
      const timer = pending.get(key);
      if (timer === undefined) return false;
      clearTimeout(timer);
      pending.delete(key);
      return true;
    },

    cancelAll() {
      const keys = [...pending.keys()];
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      return keys;
    },

    pendingKeys() {
      return [...pending.keys()];
    },

    has(key) {
      return pending.has(key);
    },
  };
}
