// A harness for the asynchronous Agenetes storage ports (README I9.4 / I9.8).
//
// Every `ThreadStore` / `EventLogStore` / `TurnStore` method may now answer
// with a promise, but the in-memory defaults the rest of the suite runs on
// answer synchronously — so those suites cannot tell a genuinely deferred
// backing (Postgres, a blob store) from a synchronous one. This wraps the
// in-memory backings so that:
//
//   - EVERY method is really asynchronous (the caller always yields), and
//   - concurrently-issued calls settle on a rotating delay, so completion
//     order deliberately differs from call order, and
//   - a named method can be PARKED by hand and then released — or failed —
//     so a test can hold one durable read/write open across a window in
//     which the instance keeps working.
//
// It lives in a `.test.ts` file on purpose: the package build emits `src`
// minus its tests (tsconfig `exclude`), and a test-only harness has no
// business in the shipped `dist`.

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { InMemoryEventLogStore, type EventLogStore } from './event-log.js';
import { InMemoryThreadStore, type ThreadStore } from './thread-store.js';
import { InMemoryTurnStore, type TurnStore } from './turn-store.js';

export type ThreadStoreMethod =
  `threadStore.${'upsert' | 'get' | 'list' | 'delete'}`;
export type EventLogStoreMethod = `eventLogStore.${
  | 'appendTurnStart'
  | 'append'
  | 'read'
  | 'readRecords'
  | 'maxSeq'
  | 'replace'
  | 'delete'}`;
export type TurnStoreMethod = `turnStore.${
  | 'append'
  | 'list'
  | 'page'
  | 'count'
  | 'fence'
  | 'replace'
  | 'delete'}`;
/** Every port method the instance can reach, addressable by name. */
export type StoreMethod =
  | ThreadStoreMethod
  | EventLogStoreMethod
  | TurnStoreMethod;

/** One parked port call, waiting for the test to decide its fate. */
export interface ParkedStoreCall {
  readonly method: StoreMethod;
  readonly args: readonly unknown[];
  readonly settled: boolean;
  /** Run the backing operation now and resolve the caller with its answer. */
  settle(): void;
  /** Reject the caller without ever touching the backing store. */
  fail(error: unknown): void;
}

export interface AsyncStores {
  readonly threadStore: ThreadStore;
  readonly eventLogStore: EventLogStore;
  readonly turnStore: TurnStore;
  /**
   * The synchronous backings. Assertions read through these to observe what
   * is durable WITHOUT going through the gate — otherwise the assertion
   * would queue behind the very call it is trying to observe.
   */
  readonly backing: {
    readonly threadStore: InMemoryThreadStore;
    readonly eventLogStore: InMemoryEventLogStore;
    readonly turnStore: InMemoryTurnStore;
  };
  /** Method names in dispatch order — the call-order ledger. */
  readonly calls: StoreMethod[];
  /** Park the next `times` calls to `method` instead of running them. */
  hold(method: StoreMethod, times?: number): void;
  /** Resolve once the `count`-th call to `method` has parked. */
  parked(method: StoreMethod, count?: number): Promise<ParkedStoreCall>;
  /** Settle every still-parked call; newest first unless `oldestFirst`. */
  settleAll(options?: { readonly oldestFirst?: boolean }): void;
}

/** Yield `count` microtasks, so a caller genuinely loses the stack. */
async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

// Rotating latencies: two calls issued back to back wait different numbers
// of microtasks, so anything that silently assumed call order == completion
// order shows up here rather than in production.
const LATENCIES = [0, 3, 1, 2];

/**
 * Wrap the three in-memory backings so every port method answers with a
 * promise. Nothing about the recorded state changes — only WHEN it changes.
 */
export function createAsyncStores(): AsyncStores {
  const backing = {
    threadStore: new InMemoryThreadStore(),
    eventLogStore: new InMemoryEventLogStore(),
    turnStore: new InMemoryTurnStore(),
  };
  const calls: StoreMethod[] = [];
  const holds = new Map<StoreMethod, number>();
  const parkedCalls: ParkedStoreCall[] = [];
  const waiters: Array<{
    readonly method: StoreMethod;
    readonly count: number;
    readonly resolve: (call: ParkedStoreCall) => void;
  }> = [];
  let dispatched = 0;

  const notifyWaiters = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      const matching = parkedCalls.filter((c) => c.method === waiter.method);
      if (matching.length >= waiter.count) {
        waiters.splice(i, 1);
        waiter.resolve(matching[waiter.count - 1]!);
      }
    }
  };

  const park = <T>(
    method: StoreMethod,
    args: readonly unknown[],
    run: () => T,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const call: ParkedStoreCall = {
        method,
        args,
        get settled() {
          return settled;
        },
        settle() {
          if (settled) return;
          settled = true;
          try {
            resolve(run());
          } catch (error) {
            reject(error);
          }
        },
        fail(error: unknown) {
          if (settled) return;
          settled = true;
          reject(error);
        },
      };
      parkedCalls.push(call);
      notifyWaiters();
    });

  const dispatch = async <T>(
    method: StoreMethod,
    args: readonly unknown[],
    run: () => T,
  ): Promise<T> => {
    calls.push(method);
    const remaining = holds.get(method) ?? 0;
    if (remaining > 0) {
      holds.set(method, remaining - 1);
      return await park(method, args, run);
    }
    await ticks(LATENCIES[dispatched++ % LATENCIES.length]!);
    return run();
  };

  const wrap = <T extends object>(prefix: string, target: T): T =>
    new Proxy(target, {
      get(inner, key) {
        const value: unknown = Reflect.get(inner, key);
        if (typeof value !== 'function' || typeof key !== 'string') {
          return value;
        }
        const method = `${prefix}.${key}` as StoreMethod;
        const fn = value as (...args: unknown[]) => unknown;
        return async (...args: unknown[]): Promise<unknown> =>
          await dispatch(method, args, () => fn.apply(inner, args));
      },
    });

  return {
    threadStore: wrap('threadStore', backing.threadStore),
    eventLogStore: wrap('eventLogStore', backing.eventLogStore),
    turnStore: wrap('turnStore', backing.turnStore),
    backing,
    calls,
    hold(method, times = Number.POSITIVE_INFINITY) {
      holds.set(method, times);
    },
    parked(method, count = 1) {
      const matching = parkedCalls.filter((c) => c.method === method);
      if (matching.length >= count) {
        return Promise.resolve(matching[count - 1]!);
      }
      return new Promise<ParkedStoreCall>((resolve) => {
        waiters.push({ method, count, resolve });
      });
    },
    settleAll(options) {
      const outstanding = parkedCalls.filter((c) => !c.settled);
      if (!options?.oldestFirst) outstanding.reverse();
      for (const call of outstanding) call.settle();
    },
  };
}

const namespace = { name: 'harness', storage: undefined };

// The harness is a module other suites import, so guard its own contract
// tests: registering them again inside every importer would run the same
// three cases five times and bury each suite's real subject.
if (expect.getState().testPath === fileURLToPath(import.meta.url)) {
  describe('asynchronous store harness', () => {
    it('answers every port method with a promise, never synchronously', async () => {
      const stores = createAsyncStores();
      const write = stores.threadStore.upsert(namespace, 'thread', {
        driverSchemaVersion: 1,
        spec: {
          threadId: 'thread',
          kind: 'external',
          workloadType: 'Deployment',
          namespace,
          spec: {},
        },
        state: { driverState: {} },
      });
      expect(write).toBeInstanceOf(Promise);
      // Not yet durable: the caller has to await to see its own write.
      expect(
        stores.backing.threadStore.get(namespace, 'thread'),
      ).toBeUndefined();
      await write;
      expect(stores.backing.threadStore.get(namespace, 'thread')).toBeDefined();
    });

    it('settles concurrently-issued calls out of call order', async () => {
      const stores = createAsyncStores();
      const order: string[] = [];
      await Promise.all(
        ['a', 'b', 'c', 'd'].map(async (threadId) => {
          await stores.eventLogStore.maxSeq(namespace, threadId);
          order.push(threadId);
        }),
      );
      expect(stores.calls).toEqual([
        'eventLogStore.maxSeq',
        'eventLogStore.maxSeq',
        'eventLogStore.maxSeq',
        'eventLogStore.maxSeq',
      ]);
      expect(order).not.toEqual(['a', 'b', 'c', 'd']);
    });

    it('parks a named method until the test releases or fails it', async () => {
      const stores = createAsyncStores();
      stores.hold('turnStore.fence', 2);
      const first = stores.turnStore.fence(namespace, 'thread');
      const second = stores.turnStore.fence(namespace, 'thread');
      const third = stores.turnStore.fence(namespace, 'thread');
      expect(await third).toBe(0); // past the hold count — runs normally

      const parkedSecond = await stores.parked('turnStore.fence', 2);
      parkedSecond.fail(new Error('fence unavailable'));
      await expect(second).rejects.toThrow('fence unavailable');
      (await stores.parked('turnStore.fence')).settle();
      expect(await first).toBe(0);
    });
  });
}
