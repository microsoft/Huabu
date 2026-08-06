// M5 INST acceptance — the mounted Agenetes instance skeleton.
//
// Exercises the three invariant surfaces end-to-end with a stub driver
// (no ACP / no host): I9.5 mounts a complete static DriverMap; the I9.3
// runtime surface get-or-creates / looks up / closes live handles; and the
// I9.4 query surface reads durable records independently from handle liveness.

import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryEventLogStore } from './event-log.js';
import { InMemoryThreadStore } from './thread-store.js';
import { InMemoryTurnStore } from './turn-store.js';

import { mountAgenetes } from './index.js';

import type {
  AgentSpec,
  AgentStateSnapshot,
  AgentTurn,
} from '@agenetes/protocol';
import type {
  AgentCreateContext,
  AgentHandle,
  TypedWorkloadSpec,
} from '@agenetes/runtime';

interface StubDriverSpec extends AgentSpec {
  readonly note?: string;
}
type StubSpec = TypedWorkloadSpec<StubDriverSpec>;
interface StubDriverState {
  readonly sessionId?: string;
}

/** A stub handle recording its close() so teardown is observable. */
class StubHandle {
  closed = false;
  constructor(
    readonly spec: StubSpec,
    readonly createContext: AgentCreateContext<StubDriverState>,
  ) {}
  close(): void {
    this.closed = true;
  }
}

/** A driver whose end-state `create(spec)` (I9.3) mints a stub handle. */
const stubSpecSchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as StubDriverSpec }
      : { success: false as const, error: new Error('expected object') };
  },
};

const stubStateSchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as StubDriverState }
      : { success: false as const, error: new Error('expected object') };
  },
};

function stubDriver() {
  return defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Job', 'Deployment'],
    specSchema: stubSpecSchema,
    stateSchema: stubStateSchema,
    initialState: () => ({}),
    create: (spec, context) =>
      new StubHandle(spec, context) as unknown as AgentHandle,
  });
}

const ns = (name: string, root?: string) => ({
  name,
  storage: root ? { root } : undefined,
});

function mount() {
  return mountAgenetes({ drivers: { external: stubDriver() } });
}

describe('mounted Agenetes instance (M5 INST skeleton)', () => {
  it('create() get-or-creates by threadId and reuse ignores spec (I9.3)', () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1', '/data/c1'),
      spec: { note: 'first' },
    };
    const h1 = inst.create(spec) as unknown as StubHandle;
    const h2 = inst.create({
      ...spec,
      spec: { note: 'second' },
    }) as unknown as StubHandle;
    expect(h2).toBe(h1);
    // reuse-ignores-spec: the live handle keeps its original spec
    expect(h1.spec.spec.note).toBe('first');
  });

  it('restart recovery keeps the persisted spec authoritative', () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1', '/data/c1'),
      spec: { note: 'persisted' },
    };
    inst.create(spec);
    inst.close(spec.threadId);

    const recovered = inst.create({
      ...spec,
      spec: { note: 'drifted' },
    }) as unknown as StubHandle;
    expect(recovered.spec.spec.note).toBe('persisted');
    expect(inst.record(spec.namespace, spec.threadId)?.spec.spec).toEqual(
      expect.objectContaining({
        note: 'persisted',
      }),
    );
  });

  it('rejects changing the driver kind of a persisted thread', () => {
    const store = new InMemoryThreadStore();
    const first = mountAgenetes({
      drivers: { external: stubDriver(), internal: stubDriver() },
      threadStore: store,
    });
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1'),
      spec: {},
    };
    first.create(spec);
    first.close(spec.threadId);

    const restarted = mountAgenetes({
      drivers: { external: stubDriver(), internal: stubDriver() },
      threadStore: store,
    });
    expect(() => restarted.create({ ...spec, kind: 'internal' })).toThrow(
      /cannot change driver kind/,
    );
  });

  it('fork() realizes a fresh target from source durable input', () => {
    const store = new InMemoryThreadStore();
    const eventLogStore = new InMemoryEventLogStore();
    const turnStore = new InMemoryTurnStore();
    const sourceNamespace = ns('canvas_1', '/data/c1');
    const targetNamespace = ns('canvas_2', '/data/c2');
    const sourceSpec: StubSpec = {
      threadId: 'source_thread',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: sourceNamespace,
      spec: { note: 'source' },
    };
    const sourceState: AgentStateSnapshot<StubDriverState> = {
      driverState: { sessionId: 'source_session' },
    };
    const sourceTurn: AgentTurn = {
      request: { type: 'user_text', content: 'before fork' },
      transcript: [{ type: 'text', data: { content: 'source answer' } }],
    };
    store.upsert(sourceNamespace, sourceSpec.threadId, {
      driverSchemaVersion: 1,
      spec: sourceSpec,
      state: sourceState,
    });
    turnStore.append(sourceNamespace, sourceSpec.threadId, {
      turn: sourceTurn,
      seqStart: 1,
      seqEnd: 2,
    });
    eventLogStore.append(sourceNamespace, sourceSpec.threadId, {
      type: 'text_delta',
      data: { content: 'source answer' },
    });
    eventLogStore.append(sourceNamespace, sourceSpec.threadId, {
      type: 'end',
      data: {},
    });
    eventLogStore.appendTurnStart(sourceNamespace, sourceSpec.threadId, {
      type: 'user_text',
      content: 'in flight',
    });
    eventLogStore.append(sourceNamespace, sourceSpec.threadId, {
      type: 'text_delta',
      data: { content: 'partial answer' },
    });
    const inst = mountAgenetes({
      drivers: { external: stubDriver() },
      threadStore: store,
      eventLogStore,
      turnStore,
    });
    const targetSpec: StubSpec = {
      threadId: 'target_thread',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: targetNamespace,
      spec: { note: 'complete target' },
    };

    const handle = inst.fork(
      { namespace: sourceNamespace, threadId: sourceSpec.threadId },
      targetSpec,
    ) as unknown as StubHandle;

    expect(handle.spec).toEqual(targetSpec);
    expect(handle.createContext.recoveryInput).toBeUndefined();
    expect(handle.createContext.forkInput).toEqual({
      source: {
        namespace: sourceNamespace,
        threadId: sourceSpec.threadId,
      },
      turns: [
        sourceTurn,
        {
          request: { type: 'user_text', content: 'in flight' },
          transcript: [{ type: 'text', data: { content: 'partial answer' } }],
          isIncomplete: true,
        },
      ],
    });
    expect(inst.record(targetNamespace, targetSpec.threadId)).toEqual({
      driverSchemaVersion: 1,
      spec: targetSpec,
      state: { driverState: {} },
    });
    expect(inst.history(targetNamespace, targetSpec.threadId).turns).toEqual(
      [],
    );
    expect(inst.record(sourceNamespace, sourceSpec.threadId)?.state).toEqual(
      sourceState,
    );
  });

  it('fork() rejects a missing source and non-fresh target', () => {
    const inst = mount();
    const namespace = ns('canvas_1');
    const targetSpec: StubSpec = {
      threadId: 'target_thread',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    };
    expect(() =>
      inst.fork({ namespace, threadId: 'missing' }, targetSpec),
    ).toThrow(/missing source thread/);

    inst.create({
      ...targetSpec,
      threadId: 'source_thread',
    });
    expect(() =>
      inst.fork(
        { namespace, threadId: 'source_thread' },
        { ...targetSpec, threadId: 'source_thread' },
      ),
    ).toThrow(/target threadId must differ/);
    inst.create(targetSpec);
    expect(() =>
      inst.fork({ namespace, threadId: 'source_thread' }, targetSpec),
    ).toThrow(/target thread already exists/);
  });

  it('get() is a pure lookup that never spawns (I9.3)', () => {
    const inst = mount();
    expect(inst.get('missing')).toBeUndefined();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1'),
      spec: {},
    };
    const created = inst.create(spec);
    expect(inst.get('thr_1')).toBe(created);
  });

  it('close() tears the handle down and evicts it (I9.3)', () => {
    const inst = mount();
    const handle = inst.create({
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1'),
      spec: {},
    }) as unknown as StubHandle;
    inst.close('thr_1');
    expect(handle.closed).toBe(true);
    expect(inst.get('thr_1')).toBeUndefined();
  });

  it('a Job is minted fresh each turn and never enters the live table (I3.2/I9.3)', () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_job',
      kind: 'external',
      workloadType: 'Job',
      namespace: ns('canvas_1', '/data/c1'),
      spec: { note: 'first' },
    };
    const h1 = inst.create(spec) as unknown as StubHandle;
    const h2 = inst.create({
      ...spec,
      spec: { note: 'second' },
    }) as unknown as StubHandle;
    // distinct handles — a Job is not cached / reused
    expect(h2).not.toBe(h1);
    expect(h1.spec.spec.note).toBe('first');
    expect(h2.spec.spec.note).toBe('second');
    // and it never registers in the live-handle table
    expect(inst.get('thr_job')).toBeUndefined();
    // but the durable record is still upserted (query surface, I9.4)
    expect(inst.record(spec.namespace, 'thr_job')?.spec.spec).toEqual(
      expect.objectContaining({ note: 'second' }),
    );
  });

  it('a transient Job (empty threadId) upserts no durable record (I9.4)', () => {
    const inst = mount();
    const namespace = ns('canvas_1', '/data/c1');
    const spec: StubSpec = {
      threadId: '',
      kind: 'external',
      workloadType: 'Job',
      namespace,
      spec: { note: 'stateless' },
    };
    // it still runs and returns a fresh handle …
    const handle = inst.create(spec) as unknown as StubHandle;
    expect(handle.spec.spec.note).toBe('stateless');
    // … but leaves no durable footprint: an empty key would collide across
    // every transient Job in the namespace and accumulate junk records.
    expect(inst.record(namespace, '')).toBeUndefined();
    expect(inst.records(namespace)).toEqual([]);
  });

  it('create() dispatches on spec.kind; unknown kind throws', () => {
    const inst = mount();
    expect(() =>
      inst.create({
        threadId: 'thr_x',
        kind: 'nope',
        workloadType: 'Deployment',
        namespace: ns('canvas_1'),
        spec: {},
      }),
    ).toThrow(/no agent driver mounted for kind 'nope'/);
  });

  it('query surface reads durable records, orthogonal to liveness (I9.4)', () => {
    const inst = mount();
    const namespace = ns('canvas_1', '/data/c1');
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    };
    inst.create(spec);

    const rec = inst.record(namespace, 'thr_1');
    expect(rec?.spec).toEqual(spec);
    expect(rec?.driverSchemaVersion).toBe(1);
    expect(rec?.state).toEqual({ driverState: {} });

    // closing the live handle does NOT drop the durable record
    inst.close('thr_1');
    expect(inst.get('thr_1')).toBeUndefined();
    expect(inst.record(namespace, 'thr_1')?.spec).toEqual(spec);
  });

  it('durable records are isolated per namespace (I4.1 / I9.4)', () => {
    const inst = mount();
    const nsA = ns('canvas_A', '/data/a');
    const nsB = ns('canvas_B', '/data/b');
    inst.create({
      threadId: 'thr_a',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: nsA,
      spec: {},
    });
    inst.create({
      threadId: 'thr_b',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: nsB,
      spec: {},
    });

    expect(inst.records(nsA).map((r) => r.spec.threadId)).toEqual(['thr_a']);
    expect(inst.records(nsB).map((r) => r.spec.threadId)).toEqual(['thr_b']);
    expect(inst.record(nsA, 'thr_b')).toBeUndefined();
  });

  it('down-feeds the durable snapshot into driver.create and preserves it on reuse (I9.7)', () => {
    const store = new InMemoryThreadStore();
    const turnStore = new InMemoryTurnStore();
    const namespace = ns('canvas_1', '/data/c1');
    const prior: AgentStateSnapshot<StubDriverState> = {
      driverState: { sessionId: 'sess_abc' },
      metadata: { currentModeId: 'ask' },
    };
    // Pre-seed a durable record as if a prior process had up-reported.
    store.upsert(namespace, 'thr_1', {
      driverSchemaVersion: 1,
      spec: {
        threadId: 'thr_1',
        kind: 'external',
        workloadType: 'Deployment',
        namespace,
        spec: {},
      } as StubSpec,
      state: prior,
    });
    const foldedTurn: AgentTurn = {
      request: { type: 'user_text', content: 'hello' },
      transcript: [{ type: 'text', data: { content: 'world' } }],
    };
    turnStore.append(namespace, 'thr_1', {
      turn: foldedTurn,
      seqStart: 1,
      seqEnd: 2,
    });
    const inst = mountAgenetes({
      drivers: { external: stubDriver() },
      threadStore: store,
      turnStore,
    });

    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    };
    // Down-feed: the driver receives the durable record at create time.
    const handle = inst.create(spec) as unknown as StubHandle;
    expect(handle.createContext.forkInput).toBeUndefined();
    expect(handle.createContext.recoveryInput?.state).toEqual(prior);
    expect(handle.createContext.recoveryInput?.turns).toEqual([foldedTurn]);

    // The state-preserving upsert must NOT clobber the persisted snapshot
    // back to `{}` — a returning thread keeps its resume token + metadata.
    expect(inst.record(namespace, 'thr_1')?.state).toEqual(prior);

    // Reuse (get-or-create) also leaves the durable state intact.
    inst.create(spec);
    expect(inst.record(namespace, 'thr_1')?.state).toEqual(prior);
  });

  it('create() throws when no driver is mounted for the requested kind', () => {
    expect(() =>
      mountAgenetes({ drivers: {} }).create({
        threadId: 'thr_1',
        kind: 'external',
        workloadType: 'Deployment',
        namespace: ns('canvas_1'),
        spec: {},
      }),
    ).toThrow(/no agent driver mounted for kind 'external'/);
  });

  it('injected ThreadStore backs the query surface (I9.4 port)', () => {
    const upsert = vi.fn();
    const list = vi.fn().mockReturnValue([]);
    const inst = mountAgenetes({
      drivers: { external: stubDriver() },
      threadStore: {
        upsert,
        get: vi.fn(),
        list,
        delete: vi.fn(),
      },
    });

    const namespace = ns('canvas_1');
    inst.create({
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    inst.records(namespace);
    expect(list).toHaveBeenCalledWith(namespace);
  });
});
