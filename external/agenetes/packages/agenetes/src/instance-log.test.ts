// M5.6/C3 acceptance — the two-tier conversation log wired into the
// instance (README I9.8). A Deployment handle is transparently decorated so
// every run() tees its frames into Tier-1 and folds its return into a
// Tier-2 AgentTurn; `history()` reads the folded turns back and
// `history({ withTail })` projects the uncovered suffix as an incomplete
// turn, while `tail()` keeps serving the raw live events.

import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { mountAgenetes } from './index.js';

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
    const handle = inst.create(deployment);
    raw!.scripts.push({
      events: [text('hi'), done('hi'), end()],
      result: [{ type: 'text', data: { content: 'hi' } }],
    });

    await drain(handle, { type: 'user_text', content: 'hello' });

    const { turns } = inst.history(ns, threadId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.request).toEqual({ type: 'user_text', content: 'hello' });
    expect(turns[0]!.transcript).toEqual([
      { type: 'text', data: { content: 'hi' } },
    ]);
    expect(turns[0]!.meta).toEqual({ stopReason: 'end_turn' });
    expect(inst.logMetadata(ns, threadId)).toEqual({
      eventCount: 4,
      turnCount: 1,
    });
  });

  it('get(threadId) returns the same logging handle, so later turns fold too', async () => {
    const inst = mount();
    inst.create(deployment);
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

    const { turns } = inst.history(ns, threadId);
    expect(turns.map((t) => t.transcript[0]!.data)).toEqual([
      { content: 'one' },
      { content: 'two' },
    ]);
  });

  it('history({ withTail }) projects the in-flight turn, no seq leaked', async () => {
    const inst = mount();
    const handle = inst.create(deployment);
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
    expect(inst.history(ns, threadId, { withTail: true }).turns[1]).toEqual({
      request: { type: 'user_text', content: 'q2' },
      transcript: [],
      isIncomplete: true,
    });
    await gen.next(); // yields live-a  → Tier-1 append
    await gen.next(); // yields live-b  → Tier-1 append

    expect(inst.logMetadata(ns, threadId)).toEqual({
      eventCount: 6,
      turnCount: 1,
    });

    const { turns } = inst.history(ns, threadId, { withTail: true });
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

  it('tail() ends when a terminal (end) frame is observed', async () => {
    const inst = mount();
    const handle = inst.create(deployment);
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
    const handle = inst.create(deployment);

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
    const handle = inst.create(jobSpec);
    raw!.scripts.push({
      events: [text('job'), end()],
      result: [],
    });
    await drain(handle, { type: 'user_text', content: 'go' });

    expect(inst.history(ns, 'thr_job').turns).toEqual([
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
    const handle = inst.create(jobSpec);
    raw!.scripts.push({
      events: [text('transient'), end()],
      result: [],
    });
    await drain(handle, { type: 'user_text', content: 'go' });

    expect(inst.history(ns, '').turns).toEqual([]);
  });
});
