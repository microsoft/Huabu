import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentRuntime,
  defineDriver,
  threadIdentityKey,
} from '@agenetes/runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  EventLog,
  FileEventLogStore,
  InMemoryEventLogStore,
} from './event-log.js';
import { createAgenetesInstance } from './instance.js';
import { FileThreadStore, InMemoryThreadStore } from './thread-store.js';

import type { EventLogStore } from './event-log.js';
import type { ThreadStore } from './thread-store.js';
import type {
  AgentStateSnapshot,
  AgentStreamEvent,
  Namespace,
  WorkloadSpec,
} from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

const threadId = 'same-client-chosen-id';
const a: Namespace = { name: 'space-a', ownerId: 'workspace-a' };
const b: Namespace = { name: 'space-b', ownerId: 'workspace-b' };
const schema = {
  safeParse: (value: unknown) => ({
    success: true as const,
    data: value as Record<string, unknown>,
  }),
};

class Handle {
  listener?: (snapshot: AgentStateSnapshot) => void;
  runGate?: Promise<void>;
  closed = false;
  controls = 0;
  onState(listener: (snapshot: AgentStateSnapshot) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  emit(mode: string) {
    this.listener?.({
      driverState: { mode },
      metadata: { currentModeId: mode, metaUpdatedAt: 1 },
    });
  }
  async *run(): AsyncGenerator<AgentStreamEvent, undefined> {
    await this.runGate;
    yield { type: 'end', data: {} };
  }
  async control() {
    this.controls++;
    return { ok: true };
  }
  close() {
    this.closed = true;
  }
}

function setup(
  store: ThreadStore = new InMemoryThreadStore(),
  logStore: EventLogStore = new InMemoryEventLogStore(),
) {
  const handles = new Map<string, Handle>();
  const driver = defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Deployment'],
    specSchema: schema,
    stateSchema: schema,
    initialState: () => ({}),
    create: (spec) => {
      const handle = new Handle();
      handles.set(threadIdentityKey(spec), handle);
      return handle as unknown as AgentHandle;
    },
  });
  const runtime = createAgentRuntime({ external: driver });
  const log = new EventLog(logStore);
  const instance = createAgenetesInstance(runtime, store, log);
  const spec = (namespace: Namespace): WorkloadSpec => ({
    kind: 'external',
    workloadType: 'Deployment',
    namespace,
    threadId,
    spec: {},
  });
  const raw = (namespace: Namespace) => {
    const handle = handles.get(threadIdentityKey({ namespace, threadId }));
    if (!handle) throw new Error('Missing test handle');
    return handle;
  };
  return { instance, spec, raw, log, store };
}

describe('namespace-qualified thread ownership', () => {
  it('closes a unique pending scoped create through the legacy entry point', async () => {
    const { instance, spec, raw, store } = setup();
    const upsert = store.upsert.bind(store);
    let release!: () => void;
    vi.spyOn(store, 'upsert').mockImplementation(
      async (namespace, id, record) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return upsert(namespace, id, record);
      },
    );
    const creating = instance.create(spec(a));
    await vi.waitFor(() => expect(release).toBeDefined());
    let closed = false;
    const closing = instance.close(threadId).then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      release();
    }
    await creating;
    await closing;
    expect(raw(a).closed).toBe(true);
    expect(instance.get(threadId, a)).toBeUndefined();
  });

  it('refuses a legacy close when two namespace creations are reserved', async () => {
    const { instance, spec, raw, store } = setup();
    const upsert = store.upsert.bind(store);
    const releases: (() => void)[] = [];
    vi.spyOn(store, 'upsert').mockImplementation(
      async (namespace, id, record) => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return upsert(namespace, id, record);
      },
    );
    const creating = [instance.create(spec(a)), instance.create(spec(b))];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    try {
      await expect(instance.close(threadId)).rejects.toThrow('ambiguous');
    } finally {
      releases.forEach((release) => release());
    }
    await Promise.all(creating);
    expect(raw(a).closed).toBe(false);
    expect(raw(b).closed).toBe(false);
    await instance.close(threadId, a);
    await instance.close(threadId, b);
  });

  it('refuses a legacy close for a live and a pending same-ID namespace', async () => {
    const { instance, spec, raw, store } = setup();
    await instance.create(spec(a));
    const upsert = store.upsert.bind(store);
    let release!: () => void;
    vi.spyOn(store, 'upsert').mockImplementation(
      async (namespace, id, record) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return upsert(namespace, id, record);
      },
    );
    const creating = instance.create(spec(b));
    await vi.waitFor(() => expect(release).toBeDefined());
    try {
      await expect(instance.close(threadId)).rejects.toThrow('ambiguous');
    } finally {
      release();
    }
    await creating;
    expect(raw(a).closed).toBe(false);
    expect(raw(b).closed).toBe(false);
    await instance.close(threadId, a);
    await instance.close(threadId, b);
  });

  it('captures queued operation identity before caller data can mutate', async () => {
    const { instance, spec, raw, store } = setup();
    const upsert = store.upsert.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const parked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(store, 'upsert').mockImplementation(
      async (namespace, id, record) => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return upsert(namespace, id, record);
      },
    );
    const incoming = spec({ ...a });
    const creating = instance.create(incoming);
    incoming.threadId = 'mutated-id';
    incoming.namespace.name = 'mutated-space';
    await parked;
    const closing = instance.close(threadId);
    release();
    await creating;
    await closing;
    expect(raw(a).closed).toBe(true);
    expect(instance.get(threadId, a)).toBeUndefined();
  });

  it('captures the live identity rather than retaining a caller-mutable namespace', async () => {
    const runtime = createAgentRuntime({});
    const namespace: Namespace = {
      name: 'mutable',
      storage: { root: '/original' },
    };
    const handle = new Handle() as unknown as AgentHandle;
    runtime.getOrCreate(threadId, () => handle, namespace);
    namespace.name = 'changed';
    if (!namespace.storage) throw new Error('Missing storage');
    namespace.storage.root = '/changed';
    expect(runtime.getIdentity(threadId)?.namespace).toEqual({
      name: 'mutable',
      storage: { root: '/original' },
    });
    await runtime.close(threadId);
    expect(runtime.get(threadId)).toBeUndefined();
    expect(
      runtime.get(threadId, {
        name: 'mutable',
        storage: { root: '/original' },
      }),
    ).toBeUndefined();
  });

  it('refuses a stale live handle report after the stored namespace owner changes', async () => {
    const { instance, spec, raw, store } = setup();
    await instance.create(spec(a));
    const record = await store.get(a, threadId);
    if (!record) throw new Error('Missing record');
    const foreign = {
      ...record,
      spec: { ...record.spec, namespace: { ...a, ownerId: 'foreign' } },
    };
    await store.upsert(a, threadId, foreign);
    raw(a).emit('old-owner');
    await expect(instance.record(a, threadId)).rejects.toThrow(
      'another namespace',
    );
    expect(await store.get(a, threadId)).toEqual(foreign);
    await expect(
      instance.updateHostMetadata(a, threadId, { title: 'old-owner' }),
    ).rejects.toThrow('another namespace');
    expect(await store.get(a, threadId)).toEqual(foreign);
    await instance.close(threadId, a);
  });

  it('runs two same-ID conversations independently and folds each namespace history', async () => {
    const { instance, spec, raw } = setup();
    const first = await instance.create(spec(a));
    const second = await instance.create(spec(b));
    let release!: () => void;
    raw(a).runGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const aRun = first.run(null, undefined);
    const pending = aRun.next();
    try {
      const bRun = second.run(null, undefined);
      expect((await bRun.next()).done).toBe(false);
      expect((await bRun.next()).done).toBe(true);
      expect((await instance.history(b, threadId)).turns).toHaveLength(1);
      expect((await instance.history(a, threadId)).turns).toHaveLength(0);
      await second.control({ type: 'set_mode', modeId: 'ask' }, undefined);
      expect(raw(b).controls).toBe(1);
      expect(raw(a).controls).toBe(0);
    } finally {
      release();
    }
    await pending;
    await aRun.next();
    expect((await instance.history(a, threadId)).turns).toHaveLength(1);
    await instance.close(threadId, a);
    await instance.close(threadId, b);
  });

  it.each(['run', 'control'])(
    'refuses a retained handle %s before using another stored owner',
    async (operation) => {
      const { instance, spec, store, log, raw } = setup();
      const handle = await instance.create(spec(a));
      const record = await store.get(a, threadId);
      if (!record) throw new Error('Missing record');
      await store.upsert(a, threadId, {
        ...record,
        spec: { ...record.spec, namespace: { ...a, ownerId: 'foreign' } },
      });
      const write =
        operation === 'run'
          ? handle.run(null, undefined).next()
          : handle.control({ type: 'set_mode', modeId: 'ask' }, undefined);
      await expect(write).rejects.toThrow('another namespace');
      expect(await log.readRecords(a, threadId)).toHaveLength(0);
      expect(raw(a).controls).toBe(0);
      await instance.close(threadId, a);
    },
  );

  it.each(['record', 'records', 'metadata', 'history', 'page', 'tail'])(
    'refuses a foreign persisted owner at the public %s boundary',
    async (operation) => {
      const root = mkdtempSync(join(tmpdir(), 'agenetes-owner-read-'));
      const namespace = {
        name: 'stored-space',
        ownerId: 'workspace-a',
        storage: { root },
      };
      const other = { ...namespace, ownerId: 'workspace-b' };
      const { instance, spec, log } = setup(
        new FileThreadStore(),
        new FileEventLogStore(),
      );
      try {
        await instance.create(spec(namespace));
        await instance.close(threadId, namespace);
        await log.append(namespace, threadId, {
          type: 'text_delta',
          data: { content: 'A private stored content' },
        });
        const read = () => {
          switch (operation) {
            case 'record':
              return instance.record(other, threadId);
            case 'records':
              return instance.records(other);
            case 'metadata':
              return instance.logMetadata(other, threadId);
            case 'history':
              return instance.history(other, threadId, { withTail: true });
            case 'page':
              return instance.historyPage(other, threadId, {
                limit: 10,
                withTail: true,
              });
            default:
              return instance
                .tail(other, threadId)
                [Symbol.asyncIterator]()
                .next();
          }
        };
        await expect(read()).rejects.toThrow('another namespace');
        await expect(
          instance.history(namespace, threadId, { withTail: true }),
        ).resolves.toBeDefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('keeps same-ID handles independent and refuses ambiguous legacy get/close', async () => {
    const { instance, spec, raw } = setup();
    const first = await instance.create(spec(a));
    const second = await instance.create(spec(b));
    expect(first).not.toBe(second);
    expect(instance.get(threadId, a)).toBe(first);
    expect(instance.get(threadId, b)).toBe(second);
    expect(() => instance.get(threadId)).toThrow('ambiguous');
    await expect(instance.close(threadId)).rejects.toThrow('ambiguous');
    await first.control({ type: 'set_mode', modeId: 'ask' }, undefined);
    expect(raw(a).controls).toBe(1);
    expect(raw(b).controls).toBe(0);
    await instance.close(threadId, a);
    expect(raw(a).closed).toBe(true);
    expect(raw(b).closed).toBe(false);
    expect(instance.get(threadId)).toBe(second);
    await instance.close(threadId);
  });

  it('does not hold B reports or reads behind A parked state write', async () => {
    const { instance, spec, raw, store } = setup();
    await instance.create(spec(a));
    await instance.create(spec(b));
    const upsert = store.upsert.bind(store);
    let finish!: () => void;
    vi.spyOn(store, 'upsert').mockImplementation(
      async (namespace, id, record) => {
        if (namespace.name === a.name && record.state.driverState.mode === 'a')
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        upsert(namespace, id, record);
      },
    );
    raw(a).emit('a');
    await vi.waitFor(() => expect(finish).toBeDefined());
    try {
      raw(b).emit('b');
      let observed: unknown;
      const read = instance.record(b, threadId).then((record) => {
        observed = record?.state.driverState;
      });
      await vi.waitFor(() => expect(observed).toEqual({ mode: 'b' }));
      await read;
    } finally {
      finish();
      await instance.close(threadId, a);
      await instance.close(threadId, b);
    }
  });

  it('does not surface B report failure from A record', async () => {
    const { instance, spec, raw, store } = setup();
    await instance.create(spec(a));
    await instance.create(spec(b));
    const upsert = store.upsert.bind(store);
    vi.spyOn(store, 'upsert').mockImplementation((namespace, id, record) => {
      if (namespace.name === b.name && record.state.driverState.mode === 'b')
        throw new Error('B write refused');
      upsert(namespace, id, record);
    });
    raw(b).emit('b');
    await expect(instance.record(a, threadId)).resolves.toBeDefined();
    await expect(instance.record(b, threadId)).rejects.toThrow(
      'B write refused',
    );
    await instance.close(threadId, a);
    await instance.close(threadId, b);
  });

  it('ends a legacy metadata stream at ambiguity and keeps scoped listeners after A closes', async () => {
    const { instance, spec, raw } = setup();
    await instance.create(spec(a));
    const legacy = instance.notifications(threadId)[Symbol.asyncIterator]();
    const first = legacy.next();
    raw(a).emit('a');
    expect((await first).value?.currentModeId).toBe('a');
    const terminal = legacy.next();
    await instance.create(spec(b));
    await expect(terminal).resolves.toEqual({ done: true, value: undefined });
    expect(() => instance.notifications(threadId)).toThrow('ambiguous');
    const scoped = instance.notifications(threadId, b)[Symbol.asyncIterator]();
    await instance.close(threadId, a);
    const next = scoped.next();
    raw(b).emit('b');
    expect((await next).value?.currentModeId).toBe('b');
    await instance.close(threadId, b);
    expect((await scoped.next()).done).toBe(true);
  });

  it('does not send B live events into A tail', async () => {
    const { instance, log } = setup();
    const tail = instance.tail(a, threadId)[Symbol.asyncIterator]();
    const next = tail.next();
    await log.append(b, threadId, {
      type: 'text_delta',
      data: { content: 'B private output' },
    });
    await log.append(a, threadId, {
      type: 'text_delta',
      data: { content: 'A private output' },
    });
    expect((await next).value).toEqual({
      type: 'text_delta',
      data: { content: 'A private output' },
    });
    await tail.return?.();
  });
});
