// The logging `run()` proxy once persistence awaits (README I9.8).
//
// The decorated `run()` is now a two-stage generator: the Tier-1 turn
// boundary is written EAGERLY, before the consumer pulls anything, and the
// turn body runs under `try/finally` so an abandoned or exploded turn still
// closes the driver's generator. Neither is observable with a synchronous
// store and a turn that always runs to completion, so these cases drive the
// abnormal exits — the ones a user hits by navigating away mid-answer or by
// having their agent crash mid-stream.

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

const ns: Namespace = { name: 'run', storage: undefined };
const threadId = 'thr_run';
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

/**
 * A handle whose generator records its own teardown, so a test can tell an
 * abandoned turn (the driver was closed) from a leaked one (it was not).
 */
class TeardownHandle {
  readonly scripts: AgentStreamEvent[][] = [];
  /** Set to throw after the listed events have been yielded. */
  explodeAfter: number | undefined;
  closedGenerators = 0;
  async *run(): AsyncGenerator<AgentStreamEvent, string> {
    const script = this.scripts.shift() ?? [];
    try {
      for (const [index, event] of script.entries()) {
        if (this.explodeAfter === index) throw new Error('driver exploded');
        yield event;
      }
      return 'driver result';
    } finally {
      this.closedGenerators++;
    }
  }
  close(): void {}
}

let raw: TeardownHandle;

function mount(stores: AsyncStores) {
  return mountAgenetes({
    drivers: {
      external: defineDriver({
        schemaVersion: 1,
        workloadTypes: ['Deployment'],
        specSchema: objectSchema,
        stateSchema: objectSchema,
        initialState: () => ({}),
        create: () => (raw = new TeardownHandle()) as unknown as AgentHandle,
      }),
    },
    threadStore: stores.threadStore,
    eventLogStore: stores.eventLogStore,
    turnStore: stores.turnStore,
  });
}

describe('run() turn boundary', () => {
  it('persists the boundary even when the consumer never pulls the generator', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);
    raw.scripts.push([text('never reached')]);

    // Constructed and dropped on the floor: recovery still has to be able to
    // see that this turn was started, which is why beginTurn does not wait
    // for the first pull.
    handle.run({ type: 'user_text', content: 'asked' } as never, {} as never);
    await expect
      .poll(() => stores.backing.eventLogStore.maxSeq(ns, threadId))
      .toBe(1);

    expect(await inst.logMetadata(ns, threadId)).toEqual({
      eventCount: 1,
      turnCount: 0,
    });
    expect(
      (await inst.history(ns, threadId, { withTail: true })).turns,
    ).toEqual([
      {
        request: { type: 'user_text', content: 'asked' },
        transcript: [],
        isIncomplete: true,
      },
    ]);
    await inst.close(threadId);
  });

  it('reports a rejected boundary on the first pull, never as an unhandled rejection', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);
    const unhandled: string[] = [];
    const watch = (reason: unknown): void => {
      unhandled.push(String(reason));
    };
    process.on('unhandledRejection', watch);
    try {
      stores.hold('eventLogStore.appendTurnStart', 1);
      const generator = handle.run(null as never, {} as never);
      (await stores.parked('eventLogStore.appendTurnStart')).fail(
        new Error('boundary write failed'),
      );
      // Give the rejection every chance to escape before anyone pulls.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled.filter((r) => r.includes('boundary write'))).toEqual([]);

      await expect(generator.next()).rejects.toThrow('boundary write failed');
      expect(stores.backing.turnStore.count(ns, threadId)).toBe(0);
    } finally {
      process.off('unhandledRejection', watch);
    }
    await inst.close(threadId);
  });
});

describe('run() proxy generator lifecycle', () => {
  it('closes the driver generator and commits no turn when the consumer abandons the turn', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);
    raw.scripts.push([text('a'), text('b'), end()]);

    const seen: AgentStreamEvent[] = [];
    for await (const event of handle.run(
      { type: 'user_text', content: 'q' } as never,
      {} as never,
    )) {
      seen.push(event);
      break;
    }

    expect(seen).toEqual([text('a')]);
    // The driver is told the turn is over, rather than being left parked on
    // a yield holding whatever session resource the turn acquired.
    expect(raw.closedGenerators).toBe(1);
    // Nothing folded: an abandoned turn stays an uncommitted Tier-1 suffix.
    expect(await inst.logMetadata(ns, threadId)).toEqual({
      eventCount: 2,
      turnCount: 0,
    });
    expect((await inst.history(ns, threadId)).turns).toEqual([]);
    await inst.close(threadId);
  });

  it('closes the driver generator and commits no turn when the driver throws mid-stream', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);
    raw.scripts.push([text('a'), text('b')]);
    raw.explodeAfter = 1;

    const seen: AgentStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of handle.run(
          { type: 'user_text', content: 'q' } as never,
          {} as never,
        )) {
          seen.push(event);
        }
      })(),
    ).rejects.toThrow('driver exploded');

    expect(seen).toEqual([text('a')]);
    expect(raw.closedGenerators).toBe(1);
    expect(stores.backing.turnStore.count(ns, threadId)).toBe(0);
    // The events that did stream stay durable — a crashed turn is still
    // recoverable as an incomplete turn, it just never folds.
    expect(
      (await inst.history(ns, threadId, { withTail: true })).turns,
    ).toMatchObject([{ isIncomplete: true }]);
    await inst.close(threadId);
  });

  it('commits one turn per run, bracketing exactly that turn’s Tier-1 range', async () => {
    const stores = createAsyncStores();
    const inst = mount(stores);
    const handle = await inst.create(deployment);

    for (const content of ['one', 'two']) {
      raw.scripts.push([text(content), end()]);
      for await (const _ of handle.run(
        { type: 'user_text', content } as never,
        {} as never,
      )) {
        // drain so the turn folds
      }
    }

    // Turn 1 owns seq 1..3 (boundary, text, end); turn 2 owns 4..6 — the
    // ranges abut with no gap, so the tail fence never re-serves a folded
    // event nor skips an unfolded one.
    expect(
      stores.backing.turnStore
        .list(ns, threadId)
        .map(({ seqStart, seqEnd }) => [seqStart, seqEnd]),
    ).toEqual([
      [1, 3],
      [4, 6],
    ]);
    expect(raw.closedGenerators).toBe(2);
    expect(
      (await inst.history(ns, threadId)).turns.map((turn) => turn.request),
    ).toEqual([
      { type: 'user_text', content: 'one' },
      { type: 'user_text', content: 'two' },
    ]);
    await inst.close(threadId);
  });
});
