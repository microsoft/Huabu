// The Tier-1 log under a genuinely asynchronous backing (README I9.8).
//
// `EventLogStore` methods may now answer with a promise, so `EventLog` can
// no longer rely on a write having landed by the time it returns. It buys
// the old ordering back with a per-`threadId` promise chain: writes queue
// behind their predecessor, and reads wait for the queue before touching
// the store. These tests drive that chain through the deferred harness —
// the only way to tell the chain apart from a store that simply happens to
// answer synchronously.

import { describe, expect, it } from 'vitest';

import { EventLog } from './event-log.js';
import { createAsyncStores } from './store-harness.test.js';

import type { EventLogRecord } from './event-log.js';
import type { AgentStreamEvent, Namespace } from '@agenetes/protocol';

const ns: Namespace = { name: 'serialization', storage: undefined };

const text = (content: string): AgentStreamEvent => ({
  type: 'text_delta',
  data: { content },
});

const contentOf = (record: EventLogRecord): string | undefined =>
  'event' in record
    ? (record.event.data as { content?: string }).content
    : undefined;

describe('EventLog write serialization per thread', () => {
  it('persists concurrent appends in call order with contiguous ascending seq', async () => {
    const stores = createAsyncStores();
    const log = new EventLog(stores.eventLogStore);
    const words = ['one', 'two', 'three', 'four', 'five'];

    // Issued in one tick, with a backing whose latencies deliberately do not
    // follow call order — the chain, not the store, is what orders them.
    const entries = await Promise.all(
      words.map(async (word) => await log.append(ns, 'thread', text(word))),
    );

    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(
      stores.backing.eventLogStore.readRecords(ns, 'thread').map(contentOf),
    ).toEqual(words);
  });

  it('fans live subscribers out in the same committed order', async () => {
    const stores = createAsyncStores();
    const log = new EventLog(stores.eventLogStore);
    const seen: number[] = [];
    log.subscribe('thread', (entry) => seen.push(entry.seq));

    await Promise.all([
      log.beginTurn(ns, 'thread', null),
      log.append(ns, 'thread', text('a')),
      log.append(ns, 'thread', text('b')),
    ]);

    // The boundary is sequenced but never published; the events follow it.
    expect(seen).toEqual([2, 3]);
  });

  it('keeps one thread flowing while another thread is stalled mid-write', async () => {
    const stores = createAsyncStores();
    const log = new EventLog(stores.eventLogStore);
    stores.hold('eventLogStore.append', 1);

    const stalled = log.append(ns, 'slow', text('stuck'));
    await stores.parked('eventLogStore.append');
    // The chain is keyed by threadId: a remote store hanging on one
    // conversation must not stop every other conversation in the space.
    expect(await log.append(ns, 'fast', text('through'))).toMatchObject({
      seq: 1,
    });
    expect(stores.backing.eventLogStore.read(ns, 'slow')).toEqual([]);

    (await stores.parked('eventLogStore.append')).settle();
    expect(await stalled).toMatchObject({ seq: 1 });
  });

  it('lets the next queued write proceed after its predecessor rejects', async () => {
    const stores = createAsyncStores();
    const log = new EventLog(stores.eventLogStore);
    stores.hold('eventLogStore.append', 1);

    const doomed = log.append(ns, 'thread', text('lost'));
    const queued = log.append(ns, 'thread', text('kept'));
    const parked = await stores.parked('eventLogStore.append');
    parked.fail(new Error('durability unavailable'));

    await expect(doomed).rejects.toThrow('durability unavailable');
    // A failed write must not wedge the conversation: the queued write runs,
    // and it takes the seq the failed one never claimed.
    expect(await queued).toMatchObject({ seq: 1 });
    expect(
      stores.backing.eventLogStore.readRecords(ns, 'thread').map(contentOf),
    ).toEqual(['kept']);
  });
});

describe('EventLog reads against queued writes', () => {
  it('reads behind every write already queued for the thread', async () => {
    const stores = createAsyncStores();
    const log = new EventLog(stores.eventLogStore);
    stores.hold('eventLogStore.append', 1);

    const first = log.append(ns, 'thread', text('first'));
    const second = log.append(ns, 'thread', text('second'));
    const reading = log.read(ns, 'thread');
    const records = log.readRecords(ns, 'thread');
    const fence = log.maxSeq(ns, 'thread');
    (await stores.parked('eventLogStore.append')).settle();
    await Promise.all([first, second]);

    // A reader that raced the writes still observes both of them — the
    // `tail` fence read depends on exactly this.
    expect((await reading).map((entry) => contentOf(entry))).toEqual([
      'first',
      'second',
    ]);
    expect(await records).toHaveLength(2);
    expect(await fence).toBe(2);
  });

  // Deliberate, and relied upon: `runAgent` reports a turn started by reading
  // `logMetadata` after the turn opened, so a `beginTurn` that failed to
  // persist has to reach that read for the turn not to be announced as
  // accepted. The cost — a history or tail read failing because a concurrent
  // append failed — is recorded in the campaign note
  // `A-read-inherits-failed-write.md`; removing the propagation means giving
  // acceptance a signal of its own first.
  it('fails a read that was waiting on a write which rejected, then recovers', async () => {
    const stores = createAsyncStores();
    const log = new EventLog(stores.eventLogStore);
    stores.hold('eventLogStore.append', 1);

    const doomed = log.append(ns, 'thread', text('lost'));
    const reading = log.read(ns, 'thread');
    const fence = log.maxSeq(ns, 'thread');
    (await stores.parked('eventLogStore.append')).fail(
      new Error('durability unavailable'),
    );

    await expect(doomed).rejects.toThrow('durability unavailable');
    await expect(reading).rejects.toThrow('durability unavailable');
    await expect(fence).rejects.toThrow('durability unavailable');
    // Confined to that window: the queue clears on settle.
    expect(await log.read(ns, 'thread')).toEqual([]);
  });
});

describe('EventLog wholesale writes against the per-thread queue', () => {
  it('replaces a log wholesale and reseeds the next append', async () => {
    const stores = createAsyncStores();
    const log = new EventLog(stores.eventLogStore);
    await log.beginTurn(ns, 'thread', null);
    await log.append(ns, 'thread', text('a'));
    const snapshot = await log.readRecords(ns, 'thread');

    await log.replace(ns, 'moved', snapshot);
    expect(await log.readRecords(ns, 'moved')).toEqual(snapshot);
    expect(await log.append(ns, 'moved', text('b'))).toMatchObject({ seq: 3 });

    await log.delete(ns, 'moved');
    expect(await log.readRecords(ns, 'moved')).toEqual([]);
  });

  // A wholesale write joins the same per-thread queue as `append` /
  // `beginTurn`. Were it beside the queue instead, the append below would run
  // concurrently with the replace — resolving, and so reporting a durable
  // `seq` to its caller — and the replace would then erase the entry that seq
  // named. Note the append is deliberately not awaited before the replace is
  // released: it cannot resolve until its turn comes.
  it('does not lose an append acknowledged while a replace is in flight', async () => {
    const stores = createAsyncStores();
    const log = new EventLog(stores.eventLogStore);
    stores.hold('eventLogStore.replace', 1);

    const replacing = log.replace(ns, 'thread', [
      { seq: 1, ts: 0, kind: 'turn_start', request: null },
    ]);
    await stores.parked('eventLogStore.replace');
    const appending = log.append(ns, 'thread', text('streamed'));
    (await stores.parked('eventLogStore.replace')).settle();
    await replacing;
    const appended = await appending;

    expect(appended.seq).toBeGreaterThan(0);
    expect(
      stores.backing.eventLogStore.readRecords(ns, 'thread').map(contentOf),
    ).toContain('streamed');
  });
});
