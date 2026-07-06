// M5 INST acceptance — the mounted Agenetes instance skeleton.
//
// Exercises the three invariant surfaces end-to-end with a stub driver
// factory (no ACP / no host): the I9.5 builder assembles a driver-factory
// dictionary; the I9.3 runtime surface get-or-creates / looks up / closes
// live handles; and the I9.4 query surface reads durable thread records
// orthogonally to handle liveness, isolated per namespace.

import { describe, expect, it, vi } from 'vitest';

import type { AgentCapabilities } from '@agenetes/protocol';
import type { AgentDriver, AgentHandle } from '@agenetes/runtime';

import { mountAgenetes, type WorkloadSpecShape } from './index.js';

const CAPS = {} as AgentCapabilities;

interface StubSpec extends WorkloadSpecShape {
  readonly note?: string;
}

/** A stub handle recording its close() so teardown is observable. */
class StubHandle {
  closed = false;
  constructor(readonly spec: StubSpec) {}
  close(): void {
    this.closed = true;
  }
}

/** A driver whose end-state `create(spec)` (I9.3) mints a stub handle. */
function stubDriver(): AgentDriver<StubSpec> {
  return {
    kind: 'stub',
    capabilities: CAPS,
    create: (spec) => new StubHandle(spec) as unknown as AgentHandle,
  };
}

const ns = (name: string, root?: string) => ({
  name,
  storage: root ? { root } : undefined,
});

function mount() {
  return mountAgenetes()
    .addFactory('stub', stubDriver)
    // driverName === contract kind (I5.1 alias); factoryName === impl id
    .register('external', 'stub')
    .build<StubSpec>();
}

describe('mounted Agenetes instance (M5 INST skeleton)', () => {
  it('create() get-or-creates by threadId and reuse ignores spec (I9.3)', () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      namespace: ns('canvas_1', '/data/c1'),
      note: 'first',
    };
    const h1 = inst.create(spec) as unknown as StubHandle;
    const h2 = inst.create({ ...spec, note: 'second' }) as unknown as StubHandle;
    expect(h2).toBe(h1);
    // reuse-ignores-spec: the live handle keeps its original spec
    expect(h1.spec.note).toBe('first');
  });

  it('get() is a pure lookup that never spawns (I9.3)', () => {
    const inst = mount();
    expect(inst.get('missing')).toBeUndefined();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
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
      namespace: ns('canvas_1'),
    }) as unknown as StubHandle;
    inst.close('thr_1');
    expect(handle.closed).toBe(true);
    expect(inst.get('thr_1')).toBeUndefined();
  });

  it('create() dispatches on spec.kind; unknown kind throws', () => {
    const inst = mount();
    expect(() =>
      inst.create({
        threadId: 'thr_x',
        kind: 'nope',
        namespace: ns('canvas_1'),
      }),
    ).toThrow(/no agent driver registered for kind 'nope'/);
  });

  it('query surface reads durable records, orthogonal to liveness (I9.4)', () => {
    const inst = mount();
    const namespace = ns('canvas_1', '/data/c1');
    const spec: StubSpec = { threadId: 'thr_1', kind: 'external', namespace };
    inst.create(spec);

    const rec = inst.record(namespace, 'thr_1');
    expect(rec?.spec).toEqual(spec);
    // AgentPersistentState derives its root from namespace.storage.root
    expect(rec?.state.storageRoot).toBe('/data/c1');

    // closing the live handle does NOT drop the durable record
    inst.close('thr_1');
    expect(inst.get('thr_1')).toBeUndefined();
    expect(inst.record(namespace, 'thr_1')?.spec).toEqual(spec);
  });

  it('durable records are isolated per namespace (I4.1 / I9.4)', () => {
    const inst = mount();
    const nsA = ns('canvas_A', '/data/a');
    const nsB = ns('canvas_B', '/data/b');
    inst.create({ threadId: 'thr_a', kind: 'external', namespace: nsA });
    inst.create({ threadId: 'thr_b', kind: 'external', namespace: nsB });

    expect(inst.records(nsA).map((r) => r.spec.threadId)).toEqual(['thr_a']);
    expect(inst.records(nsB).map((r) => r.spec.threadId)).toEqual(['thr_b']);
    expect(inst.record(nsA, 'thr_b')).toBeUndefined();
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
    inst.create({ threadId: 'thr_1', kind: 'external', namespace });
    expect(upsert).toHaveBeenCalledTimes(1);
    inst.records(namespace);
    expect(list).toHaveBeenCalledWith(namespace);
  });
});
