// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect, vi } from 'vitest';

import { coalesceInFlight } from './coalesce.js';

/** A promise plus its resolve handle, so a test can hold a run "in flight". */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Flush pending microtasks so the deferred `run` invocation lands. */
const tick = () => Promise.resolve();

describe('coalesceInFlight', () => {
  it('runs once for concurrent identical keys and shares the result', async () => {
    const inFlight = new Map<string, Promise<number>>();
    const d = deferred<number>();
    const run = vi.fn(() => d.promise);

    const a = coalesceInFlight(inFlight, 'k', run);
    const b = coalesceInFlight(inFlight, 'k', run);
    const c = coalesceInFlight(inFlight, 'k', run);

    // `run` is deferred to a microtask; after flushing, all three callers
    // share the single in-flight run.
    await tick();
    expect(run).toHaveBeenCalledTimes(1);

    d.resolve(42);
    await expect(a).resolves.toBe(42);
    await expect(b).resolves.toBe(42);
    await expect(c).resolves.toBe(42);
  });

  it('does not coalesce different keys', async () => {
    const inFlight = new Map<string, Promise<number>>();
    const run = vi.fn(() => deferred<number>().promise);

    coalesceInFlight(inFlight, 'k1', run);
    coalesceInFlight(inFlight, 'k2', run);

    await tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('evicts the entry once settled so a later call runs afresh', async () => {
    const inFlight = new Map<string, Promise<number>>();
    const run = vi.fn(async () => 1);

    await coalesceInFlight(inFlight, 'k', run);
    expect(inFlight.has('k')).toBe(false);

    await coalesceInFlight(inFlight, 'k', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('propagates rejection to every coalesced caller and still evicts', async () => {
    const inFlight = new Map<string, Promise<number>>();
    let reject!: (reason: unknown) => void;
    const run = vi.fn(
      () =>
        new Promise<number>((_resolve, rej) => {
          reject = rej;
        }),
    );

    const a = coalesceInFlight(inFlight, 'k', run);
    const b = coalesceInFlight(inFlight, 'k', run);
    await tick();
    expect(run).toHaveBeenCalledTimes(1);

    reject(new Error('boom'));

    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(inFlight.has('k')).toBe(false);
  });
});
