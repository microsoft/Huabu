// M5 INST acceptance — the mounted Agenetes instance skeleton.
//
// Exercises the three invariant surfaces end-to-end with a stub driver
// factory (no ACP / no host): the I9.5 builder assembles a driver-factory
// dictionary; the I9.3 runtime surface get-or-creates / looks up / closes
// live handles; and the I9.4 query surface reads durable thread records
// orthogonally to handle liveness, isolated per namespace.

import { describe, expect, it, vi } from 'vitest';

import { InMemoryThreadStore } from './thread-store.js';
import { InMemoryTurnStore } from './turn-store.js';

import { mountAgenetes, type WorkloadSpecShape } from './index.js';

import type {
  AgentCapabilities,
  AgentStateSnapshot,
  AgentTurn,
} from '@agenetes/protocol';
import type {
  AgentCreateContext,
  AgentDriver,
  AgentHandle,
} from '@agenetes/runtime';

const CAPS = {} as AgentCapabilities;

interface StubSpec extends WorkloadSpecShape {
  readonly note?: string;
}

/** A stub handle recording its close() so teardown is observable. */
class StubHandle {
  closed = false;
  constructor(
    readonly spec: StubSpec,
    readonly createContext: AgentCreateContext<StubSpec>,
  ) {}
  close(): void {
    this.closed = true;
  }
}

/** A driver whose end-state `create(spec)` (I9.3) mints a stub handle. */
function stubDriver(): AgentDriver<StubSpec> {
  return {
    create: (spec, context) =>
      new StubHandle(spec, context) as unknown as AgentHandle,
  };
}

const ns = (name: string, root?: string) => ({
  name,
  storage: root ? { root } : undefined,
});

function mount() {
  return (
    mountAgenetes()
      .addFactory('stub', stubDriver)
      // driverName === contract kind (I5.1 alias); factoryName === impl id
      .register('external', 'stub')
      .build<StubSpec>()
  );
}

describe('mounted Agenetes instance (M5 INST skeleton)', () => {
  it('create() get-or-creates by threadId and reuse ignores spec (I9.3)', () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1', '/data/c1'),
      note: 'first',
    };
    const h1 = inst.create(spec) as unknown as StubHandle;
    const h2 = inst.create({
      ...spec,
      note: 'second',
    }) as unknown as StubHandle;
    expect(h2).toBe(h1);
    // reuse-ignores-spec: the live handle keeps its original spec
    expect(h1.spec.note).toBe('first');
  });

  it('restart recovery keeps the persisted spec authoritative', () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1', '/data/c1'),
      note: 'persisted',
    };
    inst.create(spec);
    inst.close(spec.threadId);

    const recovered = inst.create({
      ...spec,
      note: 'drifted',
    }) as unknown as StubHandle;
    expect(recovered.spec.note).toBe('persisted');
    expect(inst.record(spec.namespace, spec.threadId)?.spec.note).toBe(
      'persisted',
    );
  });

  it('fork() realizes a fresh target from source durable input', () => {
    const store = new InMemoryThreadStore();
    const turnStore = new InMemoryTurnStore();
    const sourceNamespace = ns('canvas_1', '/data/c1');
    const targetNamespace = ns('canvas_2', '/data/c2');
    const sourceSpec: StubSpec = {
      threadId: 'source_thread',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: sourceNamespace,
      note: 'source',
    };
    const sourceState: AgentStateSnapshot = {
      sessionId: 'source_session',
    };
    const sourceTurn: AgentTurn = {
      request: { type: 'user_text', content: 'before fork' },
      transcript: [{ type: 'text', data: { content: 'source answer' } }],
    };
    store.upsert(sourceNamespace, sourceSpec.threadId, {
      spec: sourceSpec,
      state: sourceState,
    });
    turnStore.append(sourceNamespace, sourceSpec.threadId, {
      turn: sourceTurn,
      seqStart: 1,
      seqEnd: 2,
    });
    const inst = mountAgenetes({ threadStore: store, turnStore })
      .addFactory('stub', stubDriver)
      .register('external', 'stub')
      .build<StubSpec>();
    const targetSpec: StubSpec = {
      threadId: 'target_thread',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: targetNamespace,
      note: 'complete target',
    };

    const handle = inst.fork(
      { namespace: sourceNamespace, threadId: sourceSpec.threadId },
      targetSpec,
    ) as unknown as StubHandle;

    expect(handle.spec).toEqual(targetSpec);
    expect(handle.createContext.durableInput).toEqual({
      source: {
        namespace: sourceNamespace,
        threadId: sourceSpec.threadId,
      },
      record: { spec: sourceSpec, state: sourceState },
      turns: [sourceTurn],
    });
    expect(inst.record(targetNamespace, targetSpec.threadId)).toEqual({
      spec: targetSpec,
      state: {},
    });
    expect(inst.history(targetNamespace, targetSpec.threadId).turns).toEqual([
      sourceTurn,
    ]);
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
      note: 'first',
    };
    const h1 = inst.create(spec) as unknown as StubHandle;
    const h2 = inst.create({
      ...spec,
      note: 'second',
    }) as unknown as StubHandle;
    // distinct handles — a Job is not cached / reused
    expect(h2).not.toBe(h1);
    expect(h1.spec.note).toBe('first');
    expect(h2.spec.note).toBe('second');
    // and it never registers in the live-handle table
    expect(inst.get('thr_job')).toBeUndefined();
    // but the durable record is still upserted (query surface, I9.4)
    expect(inst.record(spec.namespace, 'thr_job')?.spec.note).toBe('second');
  });

  it('a transient Job (empty threadId) upserts no durable record (I9.4)', () => {
    const inst = mount();
    const namespace = ns('canvas_1', '/data/c1');
    const spec: StubSpec = {
      threadId: '',
      kind: 'external',
      workloadType: 'Job',
      namespace,
      note: 'stateless',
    };
    // it still runs and returns a fresh handle …
    const handle = inst.create(spec) as unknown as StubHandle;
    expect(handle.spec.note).toBe('stateless');
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
      }),
    ).toThrow(/no agent driver registered for kind 'nope'/);
  });

  it('query surface reads durable records, orthogonal to liveness (I9.4)', () => {
    const inst = mount();
    const namespace = ns('canvas_1', '/data/c1');
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
    };
    inst.create(spec);

    const rec = inst.record(namespace, 'thr_1');
    expect(rec?.spec).toEqual(spec);
    // A freshly-created record starts with an empty AgentStateSnapshot;
    // sessionId / metadata are filled in later via up-reports (I9.7).
    expect(rec?.state).toEqual({});

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
    });
    inst.create({
      threadId: 'thr_b',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: nsB,
    });

    expect(inst.records(nsA).map((r) => r.spec.threadId)).toEqual(['thr_a']);
    expect(inst.records(nsB).map((r) => r.spec.threadId)).toEqual(['thr_b']);
    expect(inst.record(nsA, 'thr_b')).toBeUndefined();
  });

  it('down-feeds the durable snapshot into driver.create and preserves it on reuse (I9.7)', () => {
    const store = new InMemoryThreadStore();
    const turnStore = new InMemoryTurnStore();
    const namespace = ns('canvas_1', '/data/c1');
    const prior: AgentStateSnapshot = {
      sessionId: 'sess_abc' as AgentStateSnapshot['sessionId'],
      metadata: { currentModeId: 'ask' },
    };
    // Pre-seed a durable record as if a prior process had up-reported.
    store.upsert(namespace, 'thr_1', {
      spec: {
        threadId: 'thr_1',
        kind: 'external',
        workloadType: 'Deployment',
        namespace,
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
    const inst = mountAgenetes({ threadStore: store, turnStore })
      .addFactory('stub', stubDriver)
      .register('external', 'stub')
      .build<StubSpec>();

    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
    };
    // Down-feed: the driver receives the durable record at create time.
    const handle = inst.create(spec) as unknown as StubHandle;
    expect(handle.createContext.durableInput?.record.state).toEqual(prior);
    expect(handle.createContext.durableInput?.source).toEqual({
      namespace,
      threadId: 'thr_1',
    });
    expect(handle.createContext.durableInput?.turns).toEqual([foldedTurn]);

    // The state-preserving upsert must NOT clobber the persisted snapshot
    // back to `{}` — a returning thread keeps its resume token + metadata.
    expect(inst.record(namespace, 'thr_1')?.state).toEqual(prior);

    // Reuse (get-or-create) also leaves the durable state intact.
    inst.create(spec);
    expect(inst.record(namespace, 'thr_1')?.state).toEqual(prior);
  });

  it('build() throws when a registration names an unknown factory', () => {
    expect(() =>
      mountAgenetes()
        // no factory named 'ghost' was added
        .register('external', 'ghost' as never)
        .build(),
    ).toThrow(/no driver factory named 'ghost'/);
  });

  it('injected ThreadStore backs the query surface (I9.4 port)', () => {
    const upsert = vi.fn();
    const list = vi.fn().mockReturnValue([]);
    const inst = mountAgenetes({
      threadStore: {
        upsert,
        get: vi.fn(),
        list,
        delete: vi.fn(),
      },
    })
      .addFactory('stub', stubDriver)
      .register('external', 'stub')
      .build<StubSpec>();

    const namespace = ns('canvas_1');
    inst.create({
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    inst.records(namespace);
    expect(list).toHaveBeenCalledWith(namespace);
  });
});
