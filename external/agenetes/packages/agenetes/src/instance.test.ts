// M5 INST acceptance — the mounted Agenetes instance skeleton.
//
// Exercises the three invariant surfaces end-to-end with a stub driver
// (no ACP / no host): I9.5 mounts a complete static DriverMap; the I9.3
// runtime surface get-or-creates / looks up / closes live handles; and the
// I9.4 query surface reads durable records independently from handle liveness.

import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import { AgenetesError, defineDriver } from '@agenetes/runtime';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryEventLogStore } from './event-log.js';
import { FileThreadStore, InMemoryThreadStore } from './thread-store.js';
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
  it('updates host metadata without spawning or changing spec/state', async () => {
    const threadStore = new InMemoryThreadStore();
    const driver = stubDriver();
    const create = vi.spyOn(driver, 'create');
    const inst = mountAgenetes({ drivers: { external: driver }, threadStore });
    const namespace = ns('host-metadata');
    const record = {
      driverSchemaVersion: 1,
      spec: {
        threadId: 'thread',
        kind: 'external',
        workloadType: 'Deployment' as const,
        namespace,
        spec: { note: 'original' },
      },
      state: { driverState: { sessionId: 'session' } },
      hostMetadata: { untouched: ['keep'], details: { old: true } },
    };
    threadStore.upsert(namespace, 'thread', record);
    const patch = {
      label: 'host label',
      details: { replacement: true },
      nullable: null,
    };
    const updated = await inst.updateHostMetadata(namespace, 'thread', patch);
    expect(updated.spec).toBe(record.spec);
    expect(updated.state).toBe(record.state);
    expect(updated.hostMetadata).toEqual({ untouched: ['keep'], ...patch });
    expect(record.hostMetadata).toEqual({
      untouched: ['keep'],
      details: { old: true },
    });
    patch.details.replacement = false;
    (updated.hostMetadata!.details as { replacement: boolean }).replacement =
      false;
    expect(
      (await inst.record(namespace, 'thread'))?.hostMetadata?.details,
    ).toEqual({
      replacement: true,
    });
    expect((await inst.records(namespace))[0]?.hostMetadata).toEqual({
      untouched: ['keep'],
      label: 'host label',
      details: { replacement: true },
      nullable: null,
    });
    expect(
      (await inst.updateHostMetadata(namespace, 'thread', {})).hostMetadata,
    ).toEqual((await inst.record(namespace, 'thread'))?.hostMetadata);
    expect(create).not.toHaveBeenCalled();
    expect(inst.get('thread')).toBeUndefined();
  });

  it('throws a typed missing-thread error without creating a record or handle', async () => {
    const inst = mount();
    const namespace = ns('host-metadata');
    for (const threadId of ['missing', '']) {
      await expect(
        inst.updateHostMetadata(namespace, threadId, { label: 'host' }),
      ).rejects.toThrow(AgenetesError);
      await expect(
        inst.updateHostMetadata(namespace, threadId, {}),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'thread_not_found',
          details: { namespace: namespace.name, threadId },
        }),
      );
      expect(inst.get(threadId)).toBeUndefined();
    }
    // A refused patch is this caller's error alone: reads still answer.
    expect(await inst.records(namespace)).toEqual([]);
  });

  it('rejects non-JSON patches without changing the durable record', async () => {
    const inst = mount();
    const namespace = ns('host-metadata');
    await inst.create({
      threadId: 'thread',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    });
    await inst.updateHostMetadata(namespace, 'thread', { keep: true });
    const before = await inst.record(namespace, 'thread');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const patch of [
      null,
      [],
      'bad',
      { value: undefined },
      { value: NaN },
      { value: Infinity },
      { value: 1n },
      { value: () => {} },
      { value: Symbol() },
      { value: new Date() },
      cycle,
    ]) {
      await expect(
        inst.updateHostMetadata(
          namespace,
          'thread',
          patch as Record<string, unknown>,
        ),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'invalid_host_metadata' }),
      );
      expect(await inst.record(namespace, 'thread')).toEqual(before);
    }
    await inst.close('thread');
  });

  it.each(['Deployment', 'Job'] as const)(
    'preserves host metadata through file-backed restart, %s realization, and rehome',
    async (workloadType) => {
      const scratch = mkdtempSync(
        path.join(process.cwd(), '.agenetes-host-metadata-'),
      );
      try {
        const namespace = ns('source', path.join(scratch, 'source'));
        const targetNamespace = ns('target', path.join(scratch, 'target'));
        const spec: StubSpec = {
          threadId: 'thread',
          kind: 'external',
          workloadType,
          namespace,
          spec: { note: 'source' },
        };
        const threadStore = new FileThreadStore();
        const state = { driverState: { sessionId: 'durable-session' } };
        threadStore.upsert(namespace, spec.threadId, {
          driverSchemaVersion: 1,
          spec,
          state,
        });
        const first = mountAgenetes({
          drivers: { external: stubDriver() },
          threadStore,
        });
        const hostMetadata = {
          label: 'host label',
          details: { origin: 'host' },
        };
        await first.updateHostMetadata(namespace, spec.threadId, hostMetadata);
        expect(first.get(spec.threadId)).toBeUndefined();

        const restarted = mountAgenetes({
          drivers: { external: stubDriver() },
          threadStore: new FileThreadStore(),
        });
        expect((await restarted.records(namespace))[0]?.hostMetadata).toEqual(
          hostMetadata,
        );
        const recovered = (await restarted.create(
          spec,
        )) as unknown as StubHandle;
        expect(recovered.createContext.recoveryInput?.state).toEqual(state);
        expect(recovered.createContext.recoveryInput).not.toHaveProperty(
          'hostMetadata',
        );
        expect(
          (await restarted.record(namespace, spec.threadId))?.hostMetadata,
        ).toEqual(hostMetadata);
        await restarted.close(spec.threadId);
        const targetSpec = {
          ...spec,
          namespace: targetNamespace,
          spec: { note: 'target' },
        };
        await restarted.rehome(
          { namespace, threadId: spec.threadId },
          targetSpec,
        );
        expect(
          await restarted.record(namespace, spec.threadId),
        ).toBeUndefined();

        const afterMove = mountAgenetes({
          drivers: { external: stubDriver() },
          threadStore: new FileThreadStore(),
        });
        const moved = (await afterMove.create(
          targetSpec,
        )) as unknown as StubHandle;
        expect(moved.createContext.recoveryInput?.state).toEqual(state);
        expect(await afterMove.record(targetNamespace, spec.threadId)).toEqual({
          driverSchemaVersion: 1,
          spec: targetSpec,
          state,
          hostMetadata,
        });
        await expect(
          afterMove.updateHostMetadata(namespace, spec.threadId, {}),
        ).rejects.toThrow(
          expect.objectContaining({ code: 'thread_not_found' }),
        );
        await afterMove.close(spec.threadId);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it('fork deep-copies host metadata while resetting driver state', async () => {
    const threadStore = new InMemoryThreadStore();
    const inst = mountAgenetes({
      drivers: { external: stubDriver() },
      threadStore,
    });
    const namespace = ns('host-metadata');
    const spec: StubSpec = {
      threadId: 'source',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    };
    await inst.create(spec);
    const hostMetadata = {
      label: 'source label',
      details: { tags: ['source'] },
    };
    await inst.updateHostMetadata(namespace, spec.threadId, hostMetadata);
    await inst.fork(
      { namespace, threadId: spec.threadId },
      { ...spec, threadId: 'target' },
    );
    expect((await inst.record(namespace, 'target'))?.hostMetadata).toEqual(
      hostMetadata,
    );
    expect(
      threadStore.get(namespace, 'target')?.hostMetadata?.details,
    ).not.toBe(threadStore.get(namespace, 'source')?.hostMetadata?.details);
    await inst.updateHostMetadata(namespace, 'target', {
      label: 'target label',
      details: { tags: ['target'] },
    });
    await inst.updateHostMetadata(namespace, 'source', { other: true });
    expect((await inst.record(namespace, 'source'))?.hostMetadata).toEqual({
      ...hostMetadata,
      other: true,
    });
    expect((await inst.record(namespace, 'target'))?.hostMetadata).toEqual({
      label: 'target label',
      details: { tags: ['target'] },
    });
    expect((await inst.record(namespace, 'target'))?.state).toEqual({
      driverState: {},
    });
    await inst.close('source');
    await inst.close('target');
  });

  it('create() get-or-creates by threadId and reuse ignores spec (I9.3)', async () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1', '/data/c1'),
      spec: { note: 'first' },
    };
    const h1 = (await inst.create(spec)) as unknown as StubHandle;
    const h2 = (await inst.create({
      ...spec,
      spec: { note: 'second' },
    })) as unknown as StubHandle;
    expect(h2).toBe(h1);
    // reuse-ignores-spec: the live handle keeps its original spec
    expect(h1.spec.spec.note).toBe('first');
  });

  it('restart recovery keeps the persisted spec authoritative', async () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1', '/data/c1'),
      spec: { note: 'persisted' },
    };
    await inst.create(spec);
    await inst.close(spec.threadId);

    const recovered = (await inst.create({
      ...spec,
      spec: { note: 'drifted' },
    })) as unknown as StubHandle;
    expect(recovered.spec.spec.note).toBe('persisted');
    expect(
      (await inst.record(spec.namespace, spec.threadId))?.spec.spec,
    ).toEqual(
      expect.objectContaining({
        note: 'persisted',
      }),
    );
  });

  it('rejects changing the driver kind of a persisted thread', async () => {
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
    await first.create(spec);
    await first.close(spec.threadId);

    const restarted = mountAgenetes({
      drivers: { external: stubDriver(), internal: stubDriver() },
      threadStore: store,
    });
    await expect(
      async () => await restarted.create({ ...spec, kind: 'internal' }),
    ).rejects.toThrow(/cannot change driver kind/);
  });

  it('fork() realizes a fresh target from source durable input', async () => {
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

    const handle = (await inst.fork(
      { namespace: sourceNamespace, threadId: sourceSpec.threadId },
      targetSpec,
    )) as unknown as StubHandle;

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
    expect(await inst.record(targetNamespace, targetSpec.threadId)).toEqual({
      driverSchemaVersion: 1,
      spec: targetSpec,
      state: { driverState: {} },
    });
    expect(
      (await inst.history(targetNamespace, targetSpec.threadId)).turns,
    ).toEqual([]);
    expect(
      (await inst.record(sourceNamespace, sourceSpec.threadId))?.state,
    ).toEqual(sourceState);
  });

  it('fork() rejects a missing source and non-fresh target', async () => {
    const inst = mount();
    const namespace = ns('canvas_1');
    const targetSpec: StubSpec = {
      threadId: 'target_thread',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    };
    await expect(
      async () =>
        await inst.fork({ namespace, threadId: 'missing' }, targetSpec),
    ).rejects.toThrow(/missing source thread/);

    await inst.create({
      ...targetSpec,
      threadId: 'source_thread',
    });
    await expect(
      async () =>
        await inst.fork(
          { namespace, threadId: 'source_thread' },
          { ...targetSpec, threadId: 'source_thread' },
        ),
    ).rejects.toThrow(/target threadId must differ/);
    await inst.create(targetSpec);
    await expect(
      async () =>
        await inst.fork({ namespace, threadId: 'source_thread' }, targetSpec),
    ).rejects.toThrow(/target thread already exists/);
  });

  it('get() is a pure lookup that never spawns (I9.3)', async () => {
    const inst = mount();
    expect(inst.get('missing')).toBeUndefined();
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1'),
      spec: {},
    };
    const created = await inst.create(spec);
    expect(inst.get('thr_1')).toBe(created);
  });

  it('close() tears the handle down and evicts it (I9.3)', async () => {
    const inst = mount();
    const handle = (await inst.create({
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('canvas_1'),
      spec: {},
    })) as unknown as StubHandle;
    await inst.close('thr_1');
    expect(handle.closed).toBe(true);
    expect(inst.get('thr_1')).toBeUndefined();
  });

  it('retains the cached handle and durable record when close throws, then retries idempotently', async () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'close_retry',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: ns('close_retry_source'),
      spec: { note: 'preserved workload' },
    };
    const handle = (await inst.create(spec)) as unknown as StubHandle;
    await inst.updateHostMetadata(spec.namespace, spec.threadId, {
      label: 'preserved host metadata',
    });
    const before = await inst.record(spec.namespace, spec.threadId);
    const failure = new Error('synthetic close failure');
    const close = vi.spyOn(handle, 'close').mockImplementationOnce(() => {
      throw failure;
    });

    await expect(inst.close(spec.threadId)).rejects.toThrow(failure);
    expect(handle.closed).toBe(false);
    expect(inst.get(spec.threadId)).toBe(handle);
    expect(await inst.create(spec)).toBe(handle);
    expect(await inst.record(spec.namespace, spec.threadId)).toEqual(before);

    await inst.close(spec.threadId);
    expect(handle.closed).toBe(true);
    expect(inst.get(spec.threadId)).toBeUndefined();
    expect(await inst.record(spec.namespace, spec.threadId)).toEqual(before);
    await inst.close(spec.threadId);
    expect(close).toHaveBeenCalledTimes(2);
    expect(await inst.record(spec.namespace, spec.threadId)).toEqual(before);
  });

  it('a Job is minted fresh each turn and never enters the live table (I3.2/I9.3)', async () => {
    const inst = mount();
    const spec: StubSpec = {
      threadId: 'thr_job',
      kind: 'external',
      workloadType: 'Job',
      namespace: ns('canvas_1', '/data/c1'),
      spec: { note: 'first' },
    };
    const h1 = (await inst.create(spec)) as unknown as StubHandle;
    const h2 = (await inst.create({
      ...spec,
      spec: { note: 'second' },
    })) as unknown as StubHandle;
    // distinct handles — a Job is not cached / reused
    expect(h2).not.toBe(h1);
    expect(h1.spec.spec.note).toBe('first');
    expect(h2.spec.spec.note).toBe('second');
    // and it never registers in the live-handle table
    expect(inst.get('thr_job')).toBeUndefined();
    // but the durable record is still upserted (query surface, I9.4)
    expect((await inst.record(spec.namespace, 'thr_job'))?.spec.spec).toEqual(
      expect.objectContaining({ note: 'second' }),
    );
  });

  it('a transient Job (empty threadId) upserts no durable record (I9.4)', async () => {
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
    const handle = (await inst.create(spec)) as unknown as StubHandle;
    expect(handle.spec.spec.note).toBe('stateless');
    // … but leaves no durable footprint: an empty key would collide across
    // every transient Job in the namespace and accumulate junk records.
    expect(await inst.record(namespace, '')).toBeUndefined();
    expect(await inst.records(namespace)).toEqual([]);
  });

  it('create() dispatches on spec.kind; unknown kind throws', async () => {
    const inst = mount();
    await expect(
      async () =>
        await inst.create({
          threadId: 'thr_x',
          kind: 'nope',
          workloadType: 'Deployment',
          namespace: ns('canvas_1'),
          spec: {},
        }),
    ).rejects.toThrow(/no agent driver mounted for kind 'nope'/);
  });

  it('query surface reads durable records, orthogonal to liveness (I9.4)', async () => {
    const inst = mount();
    const namespace = ns('canvas_1', '/data/c1');
    const spec: StubSpec = {
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    };
    await inst.create(spec);

    const rec = await inst.record(namespace, 'thr_1');
    expect(rec?.spec).toEqual(spec);
    expect(rec?.driverSchemaVersion).toBe(1);
    expect(rec?.state).toEqual({ driverState: {} });

    // closing the live handle does NOT drop the durable record
    await inst.close('thr_1');
    expect(inst.get('thr_1')).toBeUndefined();
    expect((await inst.record(namespace, 'thr_1'))?.spec).toEqual(spec);
  });

  it('durable records are isolated per namespace (I4.1 / I9.4)', async () => {
    const inst = mount();
    const nsA = ns('canvas_A', '/data/a');
    const nsB = ns('canvas_B', '/data/b');
    await inst.create({
      threadId: 'thr_a',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: nsA,
      spec: {},
    });
    await inst.create({
      threadId: 'thr_b',
      kind: 'external',
      workloadType: 'Deployment',
      namespace: nsB,
      spec: {},
    });

    expect((await inst.records(nsA)).map((r) => r.spec.threadId)).toEqual([
      'thr_a',
    ]);
    expect((await inst.records(nsB)).map((r) => r.spec.threadId)).toEqual([
      'thr_b',
    ]);
    expect(await inst.record(nsA, 'thr_b')).toBeUndefined();
  });

  it('down-feeds the durable snapshot into driver.create and preserves it on reuse (I9.7)', async () => {
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
    const handle = (await inst.create(spec)) as unknown as StubHandle;
    expect(handle.createContext.forkInput).toBeUndefined();
    expect(handle.createContext.recoveryInput?.state).toEqual(prior);
    expect(handle.createContext.recoveryInput?.turns).toEqual([foldedTurn]);

    // The state-preserving upsert must NOT clobber the persisted snapshot
    // back to `{}` — a returning thread keeps its resume token + metadata.
    expect((await inst.record(namespace, 'thr_1'))?.state).toEqual(prior);

    // Reuse (get-or-create) also leaves the durable state intact.
    await inst.create(spec);
    expect((await inst.record(namespace, 'thr_1'))?.state).toEqual(prior);
  });

  it('create() throws when no driver is mounted for the requested kind', async () => {
    await expect(
      async () =>
        await mountAgenetes({ drivers: {} }).create({
          threadId: 'thr_1',
          kind: 'external',
          workloadType: 'Deployment',
          namespace: ns('canvas_1'),
          spec: {},
        }),
    ).rejects.toThrow(/no agent driver mounted for kind 'external'/);
  });

  it('injected ThreadStore backs the query surface (I9.4 port)', async () => {
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
    await inst.create({
      threadId: 'thr_1',
      kind: 'external',
      workloadType: 'Deployment',
      namespace,
      spec: {},
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    await inst.records(namespace);
    expect(list).toHaveBeenCalledWith(namespace);
  });
});
