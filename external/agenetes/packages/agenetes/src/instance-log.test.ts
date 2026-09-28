// M5.6/C3 acceptance — the two-tier conversation log wired into the
// instance (README I9.8). A Deployment handle is transparently decorated so
// every run() tees its frames into Tier-1 and folds its return into a
// Tier-2 AgentTurn; `history()` reads the folded turns back and
// `history({ withTail })` projects the uncovered suffix as an incomplete
// turn, while `tail()` keeps serving the raw live events.

import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { InMemoryTurnStore, type TurnStore, mountAgenetes } from './index.js';

import type {
  AgentCapabilities,
  AgentSpec,
  AgentStreamEvent,
  FoldedMessage,
  Namespace,
  WorkloadSpec,
} from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

interface Script {
  readonly events: AgentStreamEvent[];
  readonly result: FoldedMessage[];
}

/** A handle whose run() replays a per-turn scripted event list + return. */
class ScriptedHandle {
  readonly scripts: Script[] = [];
  capabilities = {} as AgentCapabilities;

  async *run(): AsyncGenerator<AgentStreamEvent, FoldedMessage[]> {
    const script = this.scripts.shift() ?? { events: [], result: [] };
    for (const event of script.events) yield event;
    return script.result;
  }

  control(): Promise<{ ok: false; code: 'unsupported' }> {
    return Promise.resolve({ ok: false, code: 'unsupported' });
  }

  close(): void {}
}

let raw: ScriptedHandle | undefined;

const specSchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as AgentSpec }
      : { success: false as const, error: new Error('expected object') };
  },
};

const stateSchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? {
          success: true as const,
          data: input as Record<string, never>,
        }
      : { success: false as const, error: new Error('expected object') };
  },
};

function scriptedDriver() {
  return defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Job', 'Deployment'],
    specSchema,
    stateSchema,
    initialState: () => ({}),
    create: () => (raw = new ScriptedHandle()) as unknown as AgentHandle,
  });
}

function mount() {
  return mountAgenetes({ drivers: { external: scriptedDriver() } });
}

const ns: Namespace = { name: 'canvas-1', storage: undefined };
const threadId = 'thr_1';
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
const done = (message: string): AgentStreamEvent => ({
  type: 'done',
  data: { message, meta: { stopReason: 'end_turn' } },
});
const end = (): AgentStreamEvent => ({ type: 'end', data: {} });

/** Fully drive a run() to completion (folds a Tier-2 turn). */
async function drain(handle: AgentHandle, request: unknown): Promise<void> {
  for await (const _ of handle.run(request as never, {} as never)) {
    // discard — the fold happens on the generator's return
  }
}

describe('Agenetes two-tier conversation log (M5.6/C3)', () => {
  it('folds a completed Deployment run into a Tier-2 AgentTurn (history)', async () => {
    const inst = mount();
    const handle = await inst.create(deployment);
    raw!.scripts.push({
      events: [text('hi'), done('hi'), end()],
      result: [{ type: 'text', data: { content: 'hi' } }],
    });

    await drain(handle, { type: 'user_text', content: 'hello' });

    const { turns } = await inst.history(ns, threadId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.request).toEqual({ type: 'user_text', content: 'hello' });
    expect(turns[0]!.transcript).toEqual([
      { type: 'text', data: { content: 'hi' } },
    ]);
    expect(turns[0]!.meta).toEqual({ stopReason: 'end_turn' });
    expect(await inst.logMetadata(ns, threadId)).toEqual({
      eventCount: 4,
      turnCount: 1,
    });
  });

  it('get(threadId) returns the same logging handle, so later turns fold too', async () => {
    const inst = mount();
    await inst.create(deployment);
    raw!.scripts.push({
      events: [text('one'), end()],
      result: [{ type: 'text', data: { content: 'one' } }],
    });
    raw!.scripts.push({
      events: [text('two'), end()],
      result: [{ type: 'text', data: { content: 'two' } }],
    });

    await drain(inst.get(threadId)!, { type: 'user_text', content: 'a' });
    await drain(inst.get(threadId)!, { type: 'user_text', content: 'b' });

    const { turns } = await inst.history(ns, threadId);
    expect(turns.map((t) => t.transcript[0]!.data)).toEqual([
      { content: 'one' },
      { content: 'two' },
    ]);
  });

  it('history({ withTail }) projects the in-flight turn, no seq leaked', async () => {
    const inst = mount();
    const handle = await inst.create(deployment);
    // Turn 1 completes → folded (fence at its last seq).
    raw!.scripts.push({
      events: [text('committed'), end()],
      result: [{ type: 'text', data: { content: 'committed' } }],
    });
    await drain(handle, { type: 'user_text', content: 'q1' });

    // Turn 2 is driven only PART way — its events land in Tier-1 but it has
    // not returned, so no Tier-2 fold yet: the live tail must replay them.
    raw!.scripts.push({
      events: [text('live-a'), text('live-b')],
      result: [{ type: 'text', data: { content: 'live-ab' } }],
    });
    const gen = handle.run(
      { type: 'user_text', content: 'q2' } as never,
      {} as never,
    );
    expect(
      (await inst.history(ns, threadId, { withTail: true })).turns[1],
    ).toEqual({
      request: { type: 'user_text', content: 'q2' },
      transcript: [],
      isIncomplete: true,
    });
    await gen.next(); // yields live-a  → Tier-1 append
    await gen.next(); // yields live-b  → Tier-1 append

    expect(await inst.logMetadata(ns, threadId)).toEqual({
      eventCount: 6,
      turnCount: 1,
    });

    const { turns } = await inst.history(ns, threadId, { withTail: true });
    expect(turns).toHaveLength(2);
    expect(turns[1]).toEqual({
      request: { type: 'user_text', content: 'q2' },
      transcript: [{ type: 'text', data: { content: 'live-alive-b' } }],
      isIncomplete: true,
    });

    // The returned AgentTurn carries no seq / fence field — the Tier-1
    // sequence stays entirely L2-internal (I9.8).
    const keys = Object.keys(turns[1]!);
    expect(keys).not.toContain('seq');
    expect(keys).not.toContain('seqStart');
    expect(keys).not.toContain('seqEnd');
  });

  it('counts a non-null active tail as one display turn and preserves its identity on completion', async () => {
    const inst = mount();
    const handle = await inst.create(deployment);
    for (const content of ['one', 'two']) {
      raw!.scripts.push({
        events: [text(content), end()],
        result: [{ type: 'text', data: { content } }],
      });
      await drain(handle, { type: 'user_text', content });
    }
    raw!.scripts.push({
      events: [text('live')],
      result: [{ type: 'text', data: { content: 'live' } }],
    });
    const gen = handle.run(
      { type: 'user_text', content: 'three' } as never,
      {} as never,
    );
    await gen.next();

    const active = await inst.historyPage(ns, threadId, {
      limit: 2,
      withTail: true,
    });
    expect(active.groups).toHaveLength(2);
    expect(active.groups[0]!.turns[0]!.request).toMatchObject({
      content: 'two',
    });
    expect(active.groups[1]!.isActive).toBe(true);
    expect(active.groups[1]!.activeTurnIndex).toBe(0);
    const activeId = active.groups[1]!.id;

    for await (const _ of gen) {
      // finish the fold
    }
    const completed = await inst.historyPage(ns, threadId, {
      limit: 2,
      withTail: true,
    });
    expect(completed.groups[1]!.id).toBe(activeId);
    expect(completed.groups[1]!.isActive).toBeUndefined();
  });

  it.each([0, -1, 0.5, 1.5, NaN, Infinity])(
    'rejects invalid page limit %s with and without an active tail',
    async (limit) => {
      const inst = mount();
      const handle = await inst.create(deployment);
      raw!.scripts.push({ events: [text('live')], result: [] });
      const gen = handle.run(
        { type: 'user_text', content: 'question' } as never,
        {} as never,
      );
      await gen.next();

      try {
        for (const withTail of [false, true]) {
          await expect(
            inst.historyPage(ns, threadId, { limit, withTail }),
          ).rejects.toThrow('History page limit must be a positive integer');
        }
      } finally {
        for await (const _ of gen) {
          // Finish the fold even if an assertion fails.
        }
        await inst.close(threadId);
      }
    },
  );

  it('attaches a null-request active tail without consuming another display slot', async () => {
    const inst = mount();
    const handle = await inst.create(deployment);
    raw!.scripts.push({
      events: [text('committed'), end()],
      result: [{ type: 'text', data: { content: 'committed' } }],
    });
    await drain(handle, { type: 'user_text', content: 'question' });
    raw!.scripts.push({
      events: [text('resumed')],
      result: [{ type: 'text', data: { content: 'resumed' } }],
    });
    const gen = handle.run(null as never, {} as never);
    await gen.next();

    const page = await inst.historyPage(ns, threadId, {
      limit: 1,
      withTail: true,
    });
    expect(page.groups).toHaveLength(1);
    expect(page.groups[0]!.turns).toHaveLength(2);
    expect(page.groups[0]!.turns[1]!.request).toBeNull();
    expect(page.groups[0]!.isActive).toBe(true);
    expect(page.groups[0]!.activeTurnIndex).toBe(1);
  });

  it('tail() ends when a terminal (end) frame is observed', async () => {
    const inst = mount();
    const handle = await inst.create(deployment);
    raw!.scripts.push({
      events: [text('c'), end()],
      result: [{ type: 'text', data: { content: 'c' } }],
    });
    await drain(handle, { type: 'user_text', content: 'q1' });

    // Drive a second turn up to (and including) its terminal `end`, without
    // letting it return — so the tail sees the end and terminates.
    raw!.scripts.push({
      events: [text('x'), end()],
      result: [{ type: 'text', data: { content: 'x' } }],
    });
    const gen = handle.run(
      { type: 'user_text', content: 'q2' } as never,
      {} as never,
    );
    await gen.next(); // text x
    await gen.next(); // end

    const iter = inst.tail(ns, threadId)[Symbol.asyncIterator]();
    expect((await iter.next()).value).toEqual(text('x'));
    expect((await iter.next()).value).toEqual(end());
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });

  it('a live tail delivers events appended after it subscribes', async () => {
    const inst = mount();
    const handle = await inst.create(deployment);

    // Open the tail on a fresh thread (fence 0, empty backfill), then drive
    // a run so its frames arrive live.
    const iter = inst.tail(ns, threadId)[Symbol.asyncIterator]();
    const pending = iter.next(); // parks — nothing yet

    raw!.scripts.push({
      events: [text('live'), end()],
      result: [{ type: 'text', data: { content: 'live' } }],
    });
    const gen = handle.run(
      { type: 'user_text', content: 'q' } as never,
      {} as never,
    );
    await gen.next(); // yields + appends `live` → wakes the parked tail

    expect((await pending).value).toEqual(text('live'));
    await gen.next(); // end → terminal
    expect((await iter.next()).value).toEqual(end());
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });

  it('a threaded Job IS logged — history folds its turn (I9.8: any durable thread)', async () => {
    const inst = mount();
    const jobSpec: WorkloadSpec = {
      threadId: 'thr_job',
      kind: 'external',
      workloadType: 'Job',
      namespace: ns,
      spec: {},
    };
    const handle = await inst.create(jobSpec);
    raw!.scripts.push({
      events: [text('job'), end()],
      result: [],
    });
    await drain(handle, { type: 'user_text', content: 'go' });

    expect((await inst.history(ns, 'thr_job')).turns).toEqual([
      {
        request: { type: 'user_text', content: 'go' },
        transcript: [{ type: 'text', data: { content: 'job' } }],
      },
    ]);
  });

  it('a transient Job (no threadId) is NOT logged — nothing to fold against', async () => {
    const inst = mount();
    const jobSpec: WorkloadSpec = {
      threadId: '',
      kind: 'external',
      workloadType: 'Job',
      namespace: ns,
      spec: {},
    };
    const handle = await inst.create(jobSpec);
    raw!.scripts.push({
      events: [text('transient'), end()],
      result: [],
    });
    await drain(handle, { type: 'user_text', content: 'go' });

    expect((await inst.history(ns, '')).turns).toEqual([]);
  });
});

it('keeps live frames when a remote fence read completes after the turn is folded', async () => {
  const turns = new InMemoryTurnStore();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const turnStore: TurnStore = new Proxy(turns, {
    get(target, key) {
      if (key === 'fence')
        return async (...args: Parameters<typeof target.fence>) => {
          entered.resolve();
          await gate.promise;
          return target.fence(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const inst = mountAgenetes({
    drivers: { external: scriptedDriver() },
    turnStore,
  });
  const handle = await inst.create(deployment);
  const tail = inst.tail(ns, threadId)[Symbol.asyncIterator]();
  const first = tail.next();
  await entered.promise;
  raw!.scripts.push({
    events: [text('while reading fence'), end()],
    result: [],
  });
  await drain(handle, { type: 'user_text', content: 'question' });
  expect(turns.fence(ns, threadId)).toBeGreaterThan(0);
  gate.resolve();
  expect((await first).value).toEqual(text('while reading fence'));
  expect((await tail.next()).value).toEqual(end());
  expect((await tail.next()).done).toBe(true);
  await inst.close(threadId);
});

it('answers one history page without folding a turn into it twice', async () => {
  const turns = new InMemoryTurnStore();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let gated = true;
  const turnStore: TurnStore = new Proxy(turns, {
    get(target, key) {
      if (key === 'page')
        return async (...args: Parameters<typeof target.page>) => {
          // Only the first page read is held open; the reassembly that the
          // moved fence triggers has to be free to finish.
          if (gated) {
            gated = false;
            entered.resolve();
            await gate.promise;
          }
          return target.page(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const inst = mountAgenetes({
    drivers: { external: scriptedDriver() },
    turnStore,
  });
  const handle = await inst.create(deployment);
  raw!.scripts.push({ events: [text('folding'), end()], result: [] });
  const run = handle.run(
    { type: 'user_text', content: 'question' } as never,
    {} as never,
  );
  // One frame is in Tier-1 and nothing is folded yet, so the page's tail is
  // the only place this turn can appear.
  await run.next();

  const paging = inst.historyPage(ns, threadId, { limit: 10, withTail: true });
  await entered.promise;
  // The turn folds while the page read is in flight: the fence the tail was
  // built against no longer describes the log the page will return.
  for await (const _ of run) {
    // discard — the fold happens on the generator's return
  }
  expect(turns.fence(ns, threadId)).toBeGreaterThan(0);
  gate.resolve();

  const page = await paging;
  expect(page.groups.flatMap((group) => group.turns)).toHaveLength(1);
  expect(page.groups.some((group) => group.isActive === true)).toBe(false);
  await inst.close(threadId);
});
