// The whole instance driven through genuinely asynchronous stores
// (README I9.3 / I9.4 / I9.8).
//
// Every existing suite mounts the in-memory stores, which answer inside the
// caller's stack — so they cannot distinguish "this code awaited its
// persistence" from "this code got lucky because the store was synchronous".
// Here the three ports answer on a rotating delay, so concurrently-issued
// calls settle OUT of call order, and the guards that decide whether a
// `fork` / `rehome` may proceed now span several suspension points.

import { AgenetesError, defineDriver } from '@agenetes/runtime';
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
import type { AgentCreateContext, AgentHandle } from '@agenetes/runtime';

const source: Namespace = { name: 'space_source', storage: undefined };
const target: Namespace = { name: 'space_target', storage: undefined };

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

/** A handle that replays a scripted turn and remembers how it was created. */
class ScriptedHandle {
  readonly scripts: AgentStreamEvent[][] = [];
  closed = false;
  constructor(
    readonly spec: WorkloadSpec,
    readonly createContext: AgentCreateContext<AgentSpec>,
  ) {}
  async *run(): AsyncGenerator<AgentStreamEvent, undefined> {
    for (const event of this.scripts.shift() ?? []) yield event;
    return undefined;
  }
  close(): void {
    this.closed = true;
  }
}

function mount(stores: AsyncStores) {
  return mountAgenetes({
    drivers: {
      external: defineDriver({
        schemaVersion: 1,
        workloadTypes: ['Job', 'Deployment'],
        specSchema: objectSchema,
        stateSchema: objectSchema,
        initialState: () => ({}),
        create: (spec, context) =>
          new ScriptedHandle(spec, context) as unknown as AgentHandle,
      }),
    },
    threadStore: stores.threadStore,
    eventLogStore: stores.eventLogStore,
    turnStore: stores.turnStore,
  });
}

const spec = (
  namespace: Namespace,
  threadId: string,
  workloadType: WorkloadSpec['workloadType'] = 'Deployment',
): WorkloadSpec => ({
  threadId,
  kind: 'external',
  workloadType,
  namespace,
  spec: { note: namespace.name },
});

/** Run one complete scripted turn so it folds into Tier 2. */
async function turn(
  handle: AgentHandle,
  content: string,
  events: AgentStreamEvent[],
): Promise<void> {
  (handle as unknown as ScriptedHandle).scripts.push(events);
  for await (const _ of handle.run(
    { type: 'user_text', content } as never,
    {} as never,
  )) {
    // drain so the turn folds
  }
}

describe('the instance over asynchronous stores', () => {
  it('keeps a thread coherent across turns, reads and a restart', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const thread = spec(source, 'thr_async');
    const handle = await inst.create(thread);

    await turn(handle, 'one', [text('first'), end()]);
    await turn(handle, 'two', [text('second'), end()]);
    // Issued together against a backing whose latencies do not follow call
    // order: every one of these has to compose its own awaits correctly.
    const [history, page, logMetadata, records] = await Promise.all([
      inst.history(source, thread.threadId),
      inst.historyPage(source, thread.threadId, { limit: 5 }),
      inst.logMetadata(source, thread.threadId),
      inst.records(source),
    ]);
    expect(history.turns.map((t) => t.transcript[0]?.data)).toEqual([
      { content: 'first' },
      { content: 'second' },
    ]);
    expect(page.groups).toHaveLength(2);
    expect(logMetadata).toEqual({ eventCount: 6, turnCount: 2 });
    expect(records.map((record) => record.spec.threadId)).toEqual([
      thread.threadId,
    ]);

    await inst.updateHostMetadata(source, thread.threadId, { label: 'kept' });
    await inst.close(thread.threadId);
    expect((handle as unknown as ScriptedHandle).closed).toBe(true);

    // Re-realizing reads the durable record back and down-feeds it, which
    // is the restart path every host takes after a process bounce.
    const recovered = (await inst.create(thread)) as unknown as ScriptedHandle;
    expect(recovered.createContext.recoveryInput?.turns).toHaveLength(2);
    expect((await inst.record(source, thread.threadId))?.hostMetadata).toEqual({
      label: 'kept',
    });
    await inst.close(thread.threadId);
  });

  it('serializes a create and a fork racing for the same target thread', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const origin = spec(source, 'thr_origin');
    await inst.create(origin);
    await turn(inst.get(origin.threadId)!, 'q', [text('a'), end()]);

    // Both are issued before either has read anything. The lifecycle queue
    // is what stops the fork's collision guard from reading a table the
    // create is in the middle of writing.
    const targetSpec = spec(source, 'thr_target');
    const creating = inst.create(targetSpec);
    const forking = inst.fork(
      { namespace: source, threadId: origin.threadId },
      targetSpec,
    );

    await creating;
    await expect(forking).rejects.toThrow(/target thread already exists/);
    expect((await inst.history(source, targetSpec.threadId)).turns).toEqual([]);
    await inst.close(origin.threadId);
    await inst.close(targetSpec.threadId);
  });
});

describe('fork collision guards under slow durable reads', () => {
  it('refuses a target that already holds a durable record or folded turns', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const origin = spec(source, 'thr_origin');
    await inst.create(origin);
    await turn(inst.get(origin.threadId)!, 'q', [text('a'), end()]);

    const occupied = spec(target, 'thr_occupied');
    await inst.create(occupied);
    await inst.close(occupied.threadId);
    const from = { namespace: source, threadId: origin.threadId };

    // A durable record with no live handle is still an owner.
    await expect(inst.fork(from, occupied)).rejects.toThrow(
      /target thread already exists/,
    );

    // So is a thread whose record is gone but whose Tier-2 log is not — the
    // guard reads all three tables, and any one of them vetoes.
    await stores.threadStore.delete(target, occupied.threadId);
    await stores.turnStore.append(target, occupied.threadId, {
      turn: { request: null, transcript: [] },
      seqStart: 1,
      seqEnd: 1,
    });
    await expect(inst.fork(from, occupied)).rejects.toThrow(
      /target thread already exists/,
    );
    await inst.close(origin.threadId);
  });

  it('does not realize the target while a collision guard read is still in flight', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const origin = spec(source, 'thr_origin');
    await inst.create(origin);
    await turn(inst.get(origin.threadId)!, 'q', [text('a'), end()]);

    // The Tier-2 probe is the last of the three guards; park it and the
    // fork must not have written anything yet.
    stores.hold('turnStore.list', 1);
    const forking = inst.fork(
      { namespace: source, threadId: origin.threadId },
      spec(target, 'thr_forked'),
    );
    await stores.parked('turnStore.list');
    expect(
      stores.backing.threadStore.get(target, 'thr_forked'),
    ).toBeUndefined();

    stores.settleAll();
    const forked = (await forking) as unknown as ScriptedHandle;
    expect(forked.createContext.forkInput?.turns).toHaveLength(1);
    expect(await inst.record(target, 'thr_forked')).toMatchObject({
      state: { driverState: {} },
    });
    await inst.close(origin.threadId);
    await inst.close('thr_forked');
  });
});

describe('rehome failure handling under asynchronous stores', () => {
  /** Seed a durable, closed thread with one folded turn in `source`. */
  async function seed(stores: AsyncStores, inst: ReturnType<typeof mount>) {
    const thread = spec(source, 'thr_move');
    const handle = await inst.create(thread);
    await turn(handle, 'q', [text('a'), end()]);
    await inst.updateHostMetadata(source, thread.threadId, { label: 'kept' });
    await inst.close(thread.threadId);
    return {
      thread,
      record: stores.backing.threadStore.get(source, thread.threadId),
      events: stores.backing.eventLogStore.readRecords(source, thread.threadId),
      turns: stores.backing.turnStore.list(source, thread.threadId),
    };
  }

  it('restores the source and removes every target write when a late step fails', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const before = await seed(stores, inst);

    // Fail the source-record removal — the first destructive step, after
    // the whole target has already been written.
    stores.hold('threadStore.delete', 1);
    const rehoming = inst.rehome(
      { namespace: source, threadId: before.thread.threadId },
      spec(target, before.thread.threadId),
    );
    (await stores.parked('threadStore.delete')).fail(
      new Error('source record delete failed'),
    );
    await expect(rehoming).rejects.toThrow('source record delete failed');

    expect(
      stores.backing.threadStore.get(source, before.thread.threadId),
    ).toEqual(before.record);
    expect(
      stores.backing.eventLogStore.readRecords(source, before.thread.threadId),
    ).toEqual(before.events);
    expect(
      stores.backing.turnStore.list(source, before.thread.threadId),
    ).toEqual(before.turns);
    // The destination never becomes observable, so no reader sees the
    // thread in two spaces at once.
    expect(await inst.record(target, before.thread.threadId)).toBeUndefined();
    expect(
      stores.backing.eventLogStore.readRecords(target, before.thread.threadId),
    ).toEqual([]);
    expect(
      stores.backing.turnStore.list(target, before.thread.threadId),
    ).toEqual([]);
  });

  it('reports an unknown outcome when the compensation itself fails', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const before = await seed(stores, inst);

    // The first delete is the failing step; the second is the compensation
    // that should have removed the target record again.
    stores.hold('threadStore.delete', 2);
    const rehoming = inst.rehome(
      { namespace: source, threadId: before.thread.threadId },
      spec(target, before.thread.threadId),
    );
    (await stores.parked('threadStore.delete')).fail(
      new Error('source record delete failed'),
    );
    (await stores.parked('threadStore.delete', 2)).fail(
      new Error('compensation failed'),
    );

    // Two determinate failures compose into one INDETERMINATE outcome: the
    // caller must not read this as "the move simply did not happen".
    await expect(rehoming).rejects.toThrow(AgenetesError);
    await expect(rehoming).rejects.toThrow(
      expect.objectContaining({ code: 'rehome_unknown_outcome' }),
    );
    expect(
      stores.backing.threadStore.get(target, before.thread.threadId),
    ).toBeDefined();
    expect(
      stores.backing.threadStore.get(source, before.thread.threadId),
    ).toEqual(before.record);
  });

  // `rehome`'s "no live handle" precondition reads the live-handle table,
  // which a threaded Job never enters even though its `run()` IS logged. So
  // the table alone cannot answer the question the precondition is asking,
  // and a Job mid-turn used to pass it — after which the move read the source
  // log, the turn appended to it, and the move wrote a target from the
  // snapshot it had taken, erasing an event whose append had already resolved.
  it('refuses to move a thread whose turn is still streaming', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const job = spec(source, 'thr_job', 'Job');
    const handle = await inst.create(job);
    (handle as unknown as ScriptedHandle).scripts.push([
      text('a'),
      text('b'),
      end(),
    ]);
    const generator = handle.run(null as never, {} as never);
    await generator.next();

    await expect(
      inst.rehome(
        { namespace: source, threadId: job.threadId },
        spec(target, job.threadId, 'Job'),
      ),
    ).rejects.toThrow('while a turn is streaming');

    // The turn finishes untouched, and every event it acknowledged is still
    // where its caller was told it was.
    expect((await generator.next()).value).toEqual(text('b'));
    await generator.next();
    const streamed = stores.backing.eventLogStore
      .read(source, job.threadId)
      .map((entry) => entry.event);
    expect(streamed).toContainEqual(text('a'));
    expect(streamed).toContainEqual(text('b'));
    expect(stores.backing.eventLogStore.read(target, job.threadId)).toEqual([]);
  });
});
