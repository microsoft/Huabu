// The instance's notification surface backing (README I9.7) — a per-thread
// fan-out bus that turns the handle's push up-report into the L1-facing
// `notifications(threadId): AsyncIterable<AgentMetadata>` pull view.
//
// Write side (push): the instance, as the sole ThreadStore writer, persists
// each up-reported snapshot FIRST and THEN calls `publish(threadId, meta)`
// (persist-then-notify, so a query-surface read after a notification always
// observes the latest state — the ThreadStore is upstream of this bus).
//
// Read side (pull): `subscribe(threadId)` returns a queue-backed
// AsyncIterable so L1 can `for await (const meta of ...)`. Each subscriber
// has its own buffer; a slow consumer never blocks a fast producer or its
// peers. `closeThread(threadId)` ends every live subscriber for that thread
// (the `for await` loops return) when the handle is closed.

import type { AgentMetadata } from '@agenetes/protocol';

/** One subscriber's queue-backed async iterator controller. */
interface Subscriber {
  /** Buffered values not yet pulled. */
  readonly queue: AgentMetadata[];
  /** A waiting `next()` resolver, when the consumer outran the producer. */
  resolve: ((result: IteratorResult<AgentMetadata>) => void) | undefined;
  /** Set once the thread closes (or the consumer breaks) so `next` ends. */
  done: boolean;
}

/**
 * A per-`threadId` publish/subscribe fan-out over `AgentMetadata`. The
 * instance owns one; it publishes on each up-report and hands `subscribe`'s
 * AsyncIterable back to L1 through `notifications(threadId)`.
 */
export class ThreadNotificationBus {
  readonly #byThread = new Map<string, Set<Subscriber>>();

  /**
   * Push a metadata snapshot to every live subscriber of `threadId`. A
   * no-op when nobody is listening (L1 has not opened the stream yet).
   */
  publish(threadId: string, metadata: AgentMetadata): void {
    const subs = this.#byThread.get(threadId);
    if (!subs) return;
    for (const sub of subs) {
      if (sub.done) continue;
      if (sub.resolve) {
        const resolve = sub.resolve;
        sub.resolve = undefined;
        resolve({ value: metadata, done: false });
      } else {
        sub.queue.push(metadata);
      }
    }
  }

  /**
   * Open a metadata stream for `threadId`. The returned AsyncIterable
   * yields each published snapshot in order and returns (ends the `for
   * await`) when the thread is closed via {@link closeThread} or the
   * consumer breaks out of the loop.
   */
  subscribe(threadId: string): AsyncIterable<AgentMetadata> {
    const sub: Subscriber = { queue: [], resolve: undefined, done: false };
    let scope = this.#byThread.get(threadId);
    if (!scope) {
      scope = new Set();
      this.#byThread.set(threadId, scope);
    }
    scope.add(sub);

    const remove = (): void => {
      const set = this.#byThread.get(threadId);
      set?.delete(sub);
      if (set && set.size === 0) this.#byThread.delete(threadId);
    };

    const iterator: AsyncIterator<AgentMetadata> = {
      next: (): Promise<IteratorResult<AgentMetadata>> => {
        if (sub.queue.length > 0) {
          return Promise.resolve({ value: sub.queue.shift()!, done: false });
        }
        if (sub.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          sub.resolve = resolve;
        });
      },
      return: (): Promise<IteratorResult<AgentMetadata>> => {
        sub.done = true;
        remove();
        // Release a parked consumer so its `for await` terminates.
        if (sub.resolve) {
          const resolve = sub.resolve;
          sub.resolve = undefined;
          resolve({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };

    return { [Symbol.asyncIterator]: () => iterator };
  }

  /**
   * End every live subscriber for `threadId` (each `for await` returns),
   * called when the thread's handle is closed. Idempotent.
   */
  closeThread(threadId: string): void {
    const subs = this.#byThread.get(threadId);
    if (!subs) return;
    for (const sub of subs) {
      sub.done = true;
      if (sub.resolve) {
        const resolve = sub.resolve;
        sub.resolve = undefined;
        resolve({ value: undefined, done: true });
      }
    }
    this.#byThread.delete(threadId);
  }
}
