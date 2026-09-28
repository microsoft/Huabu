// `Agenetes.tail()` once its fence is a remote read (README I9.8).
//
// `createTail` used to be handed a fence NUMBER, computed before the
// iterator existed. It is now handed a thunk, and the backfill is assembled
// asynchronously — which opens a window: the turn the tail is trying to
// follow can finish, and its Tier-2 fold can move the fence past events the
// tail already captured live, all while the fence read is still in flight.
// The iterator closes that window by subscribing first, merging the live
// buffer into the backfill, and deduping on `seq`. These tests hold the
// remote reads open by hand to prove it — the only way to make the window
// wide enough to observe.

import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { createAsyncStores } from './store-harness.test.js';

import { mountAgenetes } from './index.js';

import type { AsyncStores } from './store-harness.test.js';
import type {
  AgentSpec,
  AgentStreamEvent,
  Namespace,
  WorkloadSpec,
} from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

const ns: Namespace = { name: 'tail', storage: undefined };
const threadId = 'thr_tail';
const deployment: WorkloadSpec = {
  threadId,
  kind: 'external',
  workloadType: 'Deployment',
  namespace: ns,
  spec: {},
};

const text = (content: string): AgentStreamEvent => ({
  type: 'text_delta',
  data: { content },
});
const end = (): AgentStreamEvent => ({ type: 'end', data: {} });

const objectSchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as AgentSpec }
      : { success: false as const, error: new Error('expected object') };
  },
};

/** A handle whose run() replays a per-turn scripted event list. */
class ScriptedHandle {
  readonly scripts: AgentStreamEvent[][] = [];
  async *run(): AsyncGenerator<AgentStreamEvent, undefined> {
    for (const event of this.scripts.shift() ?? []) yield event;
    return undefined;
  }
  close(): void {}
}

let raw: ScriptedHandle;

function mount(stores: AsyncStores) {
  return mountAgenetes({
    drivers: {
      external: defineDriver({
        schemaVersion: 1,
        workloadTypes: ['Deployment'],
        specSchema: objectSchema,
        stateSchema: objectSchema,
        initialState: () => ({}),
        create: () => (raw = new ScriptedHandle()) as unknown as AgentHandle,
      }),
    },
    threadStore: stores.threadStore,
    eventLogStore: stores.eventLogStore,
    turnStore: stores.turnStore,
  });
}

/** Fully drive a run() to completion, so its Tier-2 turn is folded. */
async function drain(handle: AgentHandle, request: unknown): Promise<void> {
  for await (const _ of handle.run(request as never, {} as never)) {
    // discard — the fold happens on the generator's return
  }
}

/** Collect from a tail until it ends, so duplicates and gaps both show. */
async function collect(
  iterable: AsyncIterable<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const seen: AgentStreamEvent[] = [];
  for await (const event of iterable) seen.push(event);
  return seen;
}

describe('live tail backfill against a remote fence', () => {
  it('delivers every event exactly once when a turn commits during the fence read', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);
    stores.hold('turnStore.fence', 1);

    const tail = inst.tail(ns, threadId);
    const collected = collect(tail);
    await stores.parked('turnStore.fence');

    // The whole turn runs and folds while the fence read is still parked,
    // so by the time it answers the fence already covers these events.
    raw.scripts.push([text('a'), text('b'), text('c'), end()]);
    await drain(handle, { type: 'user_text', content: 'q' });
    expect(stores.backing.turnStore.fence(ns, threadId)).toBeGreaterThan(0);

    (await stores.parked('turnStore.fence')).settle();
    expect(await collected).toEqual([text('a'), text('b'), text('c'), end()]);
    await inst.close(threadId);
  });

  it('dedups an event that the backfill read and the live fan-out both carry', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);
    stores.hold('eventLogStore.read', 1);

    const collected = collect(inst.tail(ns, threadId));
    await stores.parked('eventLogStore.read');

    // These land live (buffered by the subscription) AND, once the parked
    // durable read finally runs, in the persisted snapshot as well.
    raw.scripts.push([text('a'), text('b'), end()]);
    await drain(handle, { type: 'user_text', content: 'q' });

    (await stores.parked('eventLogStore.read')).settle();
    expect(await collected).toEqual([text('a'), text('b'), end()]);
    await inst.close(threadId);
  });

  it('follows the live stream for a tail opened before the thread has any event', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);

    const iterator = inst.tail(ns, threadId)[Symbol.asyncIterator]();
    const parked = iterator.next();
    expect(stores.backing.eventLogStore.maxSeq(ns, threadId)).toBe(0);

    raw.scripts.push([text('first'), end()]);
    const gen = handle.run(
      { type: 'user_text', content: 'q' } as never,
      {
        /* no create context */
      } as never,
    );
    await gen.next();
    expect((await parked).value).toEqual(text('first'));
    await gen.next();
    expect((await iterator.next()).value).toEqual(end());
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    await inst.close(threadId);
  });

  it('surfaces a failed fence read to the consumer instead of hanging', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    await inst.create(deployment);
    stores.hold('turnStore.fence', 1);

    const iterator = inst.tail(ns, threadId)[Symbol.asyncIterator]();
    const pulling = iterator.next();
    (await stores.parked('turnStore.fence')).fail(
      new Error('fence unavailable'),
    );

    // The iterator finishes itself (unsubscribing from the live fan-out),
    // and the pending pull reports why rather than parking forever.
    await expect(pulling).rejects.toThrow('fence unavailable');
    await expect(iterator.next()).rejects.toThrow('fence unavailable');
    await inst.close(threadId);
  });

  it('stays done once the consumer has returned, and drops later events', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);

    const iterator = inst.tail(ns, threadId)[Symbol.asyncIterator]();
    const parked = iterator.next();
    expect(await iterator.return!()).toEqual({ value: undefined, done: true });
    expect(await parked).toEqual({ value: undefined, done: true });

    raw.scripts.push([text('after-return'), end()]);
    await drain(handle, { type: 'user_text', content: 'q' });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    await inst.close(threadId);
  });
});
