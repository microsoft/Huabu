// Driver up-reports and initial realization once the ThreadStore awaits
// (README I9.4 / I9.7).
//
// A driver callback cannot await, so each up-report is pushed onto a
// per-thread promise chain and `record` / `records` / `run` / `close` await
// that chain before answering. Two orderings hang off it: the initial
// record is now written BEFORE the handle exists (an up-report can no
// longer land on an un-initialized thread), and a report made during
// teardown is drained before `close()` settles. Both are invisible with a
// synchronous store, so these run on the deferred harness.

import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { createAsyncStores } from './store-harness.test.js';

import { mountAgenetes } from './index.js';

import type { AsyncStores } from './store-harness.test.js';
import type {
  AgentMetadata,
  AgentSpec,
  AgentStateSnapshot,
  AgentStreamEvent,
  Namespace,
  WorkloadSpec,
} from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

const ns: Namespace = { name: 'reports', storage: undefined };
const threadId = 'thr_reports';
const deployment: WorkloadSpec = {
  threadId,
  kind: 'external',
  workloadType: 'Deployment',
  namespace: ns,
  spec: { note: 'realized' },
};

const meta: AgentMetadata = { currentModeId: 'ask', metaUpdatedAt: 1 };
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

/** A handle that both up-reports and streams, so the two can be interleaved. */
class ReportingHandle {
  #listener: ((snapshot: AgentStateSnapshot) => void) | undefined;
  readonly scripts: AgentStreamEvent[][] = [];
  /** Reported from inside the turn, between the listed event and the next. */
  reportAfter: { index: number; snapshot: AgentStateSnapshot } | undefined;
  closed = false;
  onState(listener: (snapshot: AgentStateSnapshot) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }
  emit(snapshot: AgentStateSnapshot): void {
    this.#listener?.(snapshot);
  }
  async *run(
    _submission?: unknown,
    _context?: unknown,
  ): AsyncGenerator<AgentStreamEvent, undefined> {
    const script = this.scripts.shift() ?? [];
    for (const [index, event] of script.entries()) {
      if (this.reportAfter?.index === index)
        this.emit(this.reportAfter.snapshot);
      yield event;
    }
    return undefined;
  }
  close(): void {
    this.closed = true;
  }
}

let created: number;

function mount(stores: AsyncStores) {
  created = 0;
  return mountAgenetes({
    drivers: {
      external: defineDriver({
        schemaVersion: 1,
        workloadTypes: ['Job', 'Deployment'],
        specSchema: objectSchema,
        stateSchema: objectSchema,
        initialState: () => ({}),
        create: () => {
          created++;
          return new ReportingHandle() as unknown as AgentHandle;
        },
      }),
    },
    threadStore: stores.threadStore,
    eventLogStore: stores.eventLogStore,
    turnStore: stores.turnStore,
  });
}

describe('realization against an asynchronous ThreadStore', () => {
  it('writes the initial record before the driver handle exists', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    stores.hold('threadStore.upsert', 1);

    const creating = inst.create(deployment);
    await stores.parked('threadStore.upsert');
    // The driver is not built while its record is still in flight, so an
    // immediate up-report can never precede — and so overwrite — the record
    // that initialization is in the middle of writing.
    expect(created).toBe(0);
    expect(inst.get(threadId)).toBeUndefined();

    (await stores.parked('threadStore.upsert')).settle();
    const handle = await creating;
    expect(created).toBe(1);
    expect(inst.get(threadId)).toBe(handle);
    // Two reads precede the write: `create` looks for a persisted spec to
    // stay authoritative across restart, then realization re-reads the
    // record it is about to merge into.
    expect(stores.calls.slice(0, 3)).toEqual([
      'threadStore.get',
      'threadStore.get',
      'threadStore.upsert',
    ]);
    await inst.close(threadId);
  });

  it('touches the ThreadStore not at all for a transient Job', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);

    const handle = await inst.create({
      ...deployment,
      threadId: '',
      workloadType: 'Job',
    });

    expect(handle).toBeDefined();
    // An empty key would collide across every transient Job in the space,
    // so realization skips the store entirely rather than writing junk.
    expect(
      stores.calls.filter((call) => call.startsWith('threadStore.')),
    ).toEqual([]);
    expect(await inst.record(ns, '')).toBeUndefined();
    expect(await inst.records(ns)).toEqual([]);
  });
});

describe('up-report ordering', () => {
  it('drains a snapshot reported during teardown before close() settles', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = (await inst.create(
      deployment,
    )) as unknown as ReportingHandle;

    stores.hold('threadStore.upsert', 1);
    handle.emit({ driverState: { sessionId: 'last word' }, metadata: meta });
    await stores.parked('threadStore.upsert');

    let settled = false;
    const closing = inst.close(threadId).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // close() is the host's "this thread is finished" point; it must not
    // report success while the driver's last snapshot is still unwritten.
    expect(settled).toBe(false);

    (await stores.parked('threadStore.upsert')).settle();
    await closing;
    expect(await inst.record(ns, threadId)).toMatchObject({
      state: { driverState: { sessionId: 'last word' }, metadata: meta },
    });
  });

  it('merges a mid-turn up-report onto the record realization wrote', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = (await inst.create(
      deployment,
    )) as unknown as ReportingHandle;
    await inst.updateHostMetadata(ns, threadId, { label: 'host owned' });

    handle.scripts.push([text('a'), text('b'), end()]);
    handle.reportAfter = {
      index: 1,
      snapshot: { driverState: { sessionId: 'mid turn' }, metadata: meta },
    };
    for await (const _ of handle.run(
      { type: 'user_text', content: 'q' } as never,
      {} as never,
    )) {
      // drain so the turn folds
    }

    // The up-report carries only the driver's state; it re-reads the record
    // it is amending, so neither the spec realization wrote nor the host's
    // own metadata is collateral damage.
    expect(await inst.record(ns, threadId)).toEqual({
      driverSchemaVersion: 1,
      spec: deployment,
      state: { driverState: { sessionId: 'mid turn' }, metadata: meta },
      hostMetadata: { label: 'host owned' },
    });
    expect((await inst.history(ns, threadId)).turns).toHaveLength(1);
    await inst.close(threadId);
  });

  it('surfaces a failed up-report on record(), run() and close()', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = (await inst.create(
      deployment,
    )) as unknown as ReportingHandle;

    stores.hold('threadStore.upsert', 1);
    handle.emit({ driverState: { sessionId: 'never stored' } });
    (await stores.parked('threadStore.upsert')).fail(
      new Error('durability unavailable'),
    );

    // A driver callback cannot be told its write failed, so the failure is
    // held for the next caller to trip over — once. Reporting it again would
    // mean answering a question about the thread with a write from minutes
    // ago, which is what a rejection left sitting in the queue used to do.
    await expect(inst.record(ns, threadId)).rejects.toThrow(
      'durability unavailable',
    );
    handle.scripts.push([text('a'), end()]);
    await (async () => {
      for await (const _ of handle.run(null as never, {} as never)) {
        // drain
      }
    })();
    await inst.close(threadId);
    expect(handle.closed).toBe(true);
  });

  // The queue is kept always-settled so a failed link cannot stop the next
  // one being attempted. Were the rejection left in the queue instead,
  // `.then` would forward it without running the callback and every later
  // snapshot would be dropped in silence.
  it('keeps persisting up-reports after one of them fails', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = (await inst.create(
      deployment,
    )) as unknown as ReportingHandle;

    stores.hold('threadStore.upsert', 1);
    handle.emit({ driverState: { sessionId: 'lost' } });
    (await stores.parked('threadStore.upsert')).fail(
      new Error('durability unavailable'),
    );
    await expect(inst.record(ns, threadId)).rejects.toThrow(
      'durability unavailable',
    );

    handle.emit({ driverState: { sessionId: 'recovered' } });
    await expect
      .poll(
        () => stores.backing.threadStore.get(ns, threadId)?.state.driverState,
      )
      .toEqual({ sessionId: 'recovered' });
    await inst.close(threadId);
  });

  // The queue is per-thread but the thread table is per-namespace (I4.1), so
  // an enumeration may only wait for the writes that could change its answer.
  it('enumerates a namespace while another namespace has a write parked', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const elsewhere: Namespace = { name: 'reports-elsewhere' };
    const elsewhereThread = 'thr_reports_elsewhere';
    const handle = (await inst.create(
      deployment,
    )) as unknown as ReportingHandle;
    await inst.create({
      ...deployment,
      threadId: elsewhereThread,
      namespace: elsewhere,
    });

    stores.hold('threadStore.upsert', 1);
    handle.emit({ driverState: { sessionId: 'in flight' } });
    await stores.parked('threadStore.upsert');

    // A regression does not answer wrongly here — it never answers at all, so
    // the read is raced against a window rather than simply awaited.
    const listed = await Promise.race([
      inst.records(elsewhere),
      new Promise<'never answered'>((resolve) => {
        setTimeout(() => resolve('never answered'), 20);
      }),
    ]);
    expect(listed).toEqual([
      expect.objectContaining({
        spec: expect.objectContaining({ threadId: elsewhereThread }),
      }),
    ]);

    (await stores.parked('threadStore.upsert')).settle();
    await inst.close(elsewhereThread);
    await inst.close(threadId);
  });
});
