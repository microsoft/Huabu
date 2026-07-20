// M5.5/A3.0 acceptance — the notification surface (README I9.7).
//
// The instance registers ONE up-report listener per live Deployment handle,
// persists each full snapshot into the ThreadStore FIRST, then re-emits its
// metadata on `notifications(threadId)` (persist-then-notify). A handle
// without `onState` wires nothing and its stream stays empty; `close` ends
// every open stream.

import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { mountAgenetes } from './index.js';

import type {
  AgentSpec,
  AgentMetadata,
  AgentStateSnapshot,
} from '@agenetes/protocol';
import type { AgentHandle, TypedWorkloadSpec } from '@agenetes/runtime';

type StubSpec = TypedWorkloadSpec<AgentSpec>;
interface StubDriverState {
  readonly sessionId?: string;
}

/** A stub handle that captures its up-report listener so a test can fire it. */
class ReportingHandle {
  #listener: ((s: AgentStateSnapshot<StubDriverState>) => void) | undefined;
  closed = false;
  constructor(readonly spec: StubSpec) {}
  onState(
    listener: (s: AgentStateSnapshot<StubDriverState>) => void,
  ): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }
  emit(snapshot: AgentStateSnapshot<StubDriverState>): void {
    this.#listener?.(snapshot);
  }
  get wired(): boolean {
    return this.#listener !== undefined;
  }
  close(): void {
    this.closed = true;
  }
}

/** A stub handle with NO up-report seam. */
class SilentHandle {
  constructor(readonly spec: StubSpec) {}
  close(): void {}
}

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
      ? { success: true as const, data: input as StubDriverState }
      : { success: false as const, error: new Error('expected object') };
  },
};

function driver(make: (spec: StubSpec) => unknown) {
  return defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Deployment'],
    specSchema,
    stateSchema,
    initialState: () => ({}),
    create: (spec) => make(spec) as AgentHandle,
  });
}

const ns = (name: string, root?: string) => ({
  name,
  storage: root ? { root } : undefined,
});

function mount(make: (spec: StubSpec) => unknown) {
  return mountAgenetes({ drivers: { external: driver(make) } });
}

const deployment = (threadId: string): StubSpec => ({
  threadId,
  kind: 'external',
  workloadType: 'Deployment',
  namespace: ns('canvas_1', '/data/c1'),
  spec: {},
});

const meta: AgentMetadata = { currentModeId: 'ask', metaUpdatedAt: 1 };

/** Pull `n` values from an async iterable. */
async function take<T>(it: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) {
    out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

describe('notification surface (M5.5/A3.0, I9.7)', () => {
  it('persists the up-reported snapshot then re-emits its metadata', async () => {
    const inst = mount((spec) => new ReportingHandle(spec));
    const spec = deployment('thr_1');
    const handle = inst.create(spec) as unknown as ReportingHandle;

    const collected = take(inst.notifications('thr_1'), 1);
    handle.emit({ driverState: { sessionId: 'sess-1' }, metadata: meta });

    expect(await collected).toEqual([meta]);
    // persist-then-notify: the record already carries the full snapshot.
    const rec = inst.record(spec.namespace, 'thr_1');
    expect(rec).toMatchObject({
      driverSchemaVersion: 1,
      state: { driverState: { sessionId: 'sess-1' }, metadata: meta },
    });
  });

  it('persists a driver-state-only snapshot without emitting to L1', async () => {
    const inst = mount((spec) => new ReportingHandle(spec));
    const spec = deployment('thr_1');
    const handle = inst.create(spec) as unknown as ReportingHandle;

    const collected = take(inst.notifications('thr_1'), 1);
    handle.emit({ driverState: { sessionId: 'sess-1' } });
    handle.emit({ driverState: { sessionId: 'sess-1' }, metadata: meta });

    // Only the metadata-bearing snapshot reaches L1.
    expect(await collected).toEqual([meta]);
    expect(
      (
        inst.record(spec.namespace, 'thr_1')?.state
          .driverState as StubDriverState
      ).sessionId,
    ).toBe('sess-1');
  });

  it('wires the listener exactly once across get-or-create reuse', () => {
    const inst = mount((spec) => new ReportingHandle(spec));
    const spec = deployment('thr_1');
    const h1 = inst.create(spec) as unknown as ReportingHandle;
    const h2 = inst.create(spec) as unknown as ReportingHandle;
    expect(h1).toBe(h2); // reuse returns the same handle
    expect(h1.wired).toBe(true);
  });

  it('close() ends every open notification stream', async () => {
    const inst = mount((spec) => new ReportingHandle(spec));
    inst.create(deployment('thr_1'));

    const drained: AgentMetadata[] = [];
    const loop = (async () => {
      for await (const m of inst.notifications('thr_1')) drained.push(m);
    })();

    inst.close('thr_1');
    await loop; // returns because the stream ended
    expect(drained).toEqual([]);
  });

  it('a handle with no onState leaves the notification stream empty', async () => {
    const inst = mount((spec) => new SilentHandle(spec));
    inst.create(deployment('thr_1'));

    const drained: AgentMetadata[] = [];
    const loop = (async () => {
      for await (const m of inst.notifications('thr_1')) drained.push(m);
    })();

    inst.close('thr_1'); // nothing was ever published
    await loop;
    expect(drained).toEqual([]);
  });
});
