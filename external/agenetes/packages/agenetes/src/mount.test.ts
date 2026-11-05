import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it } from 'vitest';

import { mountAgenetes } from './mount.js';
import { InMemoryThreadStore } from './thread-store.js';

const emptySchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as Record<string, never> }
      : { success: false as const, error: new Error('expected object') };
  },
};

const driver = defineDriver({
  schemaVersion: 1,
  workloadTypes: ['Deployment'],
  specSchema: emptySchema,
  stateSchema: emptySchema,
  initialState: () => ({}),
  create: () =>
    ({
      capabilities: {},
      async run() {
        return undefined;
      },
      async control() {
        return { ok: false as const, code: 'unsupported' as const };
      },
      close() {},
    }) as never,
});

describe('mountAgenetes static driver map', () => {
  it('mounts a complete host-constructed driver map', async () => {
    const instance = mountAgenetes({ drivers: { external: driver } });
    // `create` is async, so the mount is only proven by the settled promise —
    // a rejected realization never reaches a synchronous throw assertion.
    await expect(
      instance.create({
        kind: 'external',
        workloadType: 'Deployment',
        namespace: { name: 'canvas-1' },
        threadId: 'thread-1',
        spec: {},
      }),
    ).resolves.toBeDefined();
  });

  it('does not provide mutable post-mount registration', () => {
    const instance = mountAgenetes({ drivers: { external: driver } });
    expect(instance).not.toHaveProperty('addFactory');
    expect(instance).not.toHaveProperty('register');
    expect(instance).not.toHaveProperty('build');
  });
});

// A guessed thread id must not alias another namespace's live deployment,
// including when the attacker's namespace is the first to realize after boot.
it.each([
  ['carol', 'erin'],
  ['erin', 'carol'],
])(
  'refuses cross-namespace reuse from %s to %s before persisting an alias',
  async (first, second) => {
    const instance = mountAgenetes({ drivers: { external: driver } });
    const spec = {
      kind: 'external',
      workloadType: 'Deployment' as const,
      namespace: { name: first },
      threadId: 'shared-id',
      spec: {},
    };
    const handle = await instance.create(spec);
    await expect(
      instance.create({ ...spec, namespace: { name: second } }),
    ).rejects.toThrow('another namespace');
    expect(
      await instance.record({ name: second }, 'shared-id'),
    ).toBeUndefined();
    expect(instance.get('shared-id', { name: first })).toBe(handle);
    expect(() => instance.get('shared-id', { name: second })).toThrow(
      'another namespace',
    );
    await expect(instance.close('shared-id', { name: second })).rejects.toThrow(
      'another namespace',
    );
    expect(await instance.create(spec)).toBe(handle);
    await instance.close('shared-id', { name: first });
    expect(
      await instance.create({ ...spec, namespace: { name: second } }),
    ).not.toBe(handle);
  },
);

it('reserves the namespace across concurrent deployment creation', async () => {
  const instance = mountAgenetes({ drivers: { external: driver } });
  const spec = {
    kind: 'external',
    workloadType: 'Deployment' as const,
    threadId: 'racing-id',
    spec: {},
  };
  const results = await Promise.allSettled(
    ['a', 'b'].map((name) => instance.create({ ...spec, namespace: { name } })),
  );
  expect(results.map((r) => r.status).sort()).toEqual([
    'fulfilled',
    'rejected',
  ]);
});

it.each([undefined, { root: '/same-root' }])(
  'refuses a live thread from another owner even with the same name and storage %j',
  async (storage) => {
    const instance = mountAgenetes({ drivers: { external: driver } });
    const namespace = { name: 'same-space', ownerId: 'workspace-a', storage };
    const spec = {
      kind: 'external',
      workloadType: 'Deployment' as const,
      namespace,
      threadId: 'same-thread',
      spec: {},
    };
    const handle = await instance.create(spec);
    const other = { ...namespace, ownerId: 'workspace-b' };
    await expect(
      instance.create({ ...spec, namespace: other }),
    ).rejects.toThrow('another namespace');
    expect(() => instance.get(spec.threadId, other)).toThrow(
      'another namespace',
    );
    await expect(instance.close(spec.threadId, other)).rejects.toThrow(
      'another namespace',
    );
    expect(instance.get(spec.threadId, namespace)).toBe(handle);
    await instance.close(spec.threadId, namespace);
  },
);

it('keeps a live thread accessible when its owner moves namespace storage', async () => {
  const instance = mountAgenetes({ drivers: { external: driver } });
  const namespace = {
    name: 'same-space',
    ownerId: 'workspace-a',
    storage: { root: '/before' },
  };
  const spec = {
    kind: 'external',
    workloadType: 'Deployment' as const,
    namespace,
    threadId: 'same-thread',
    spec: {},
  };
  const handle = await instance.create(spec);
  const moved = { ...namespace, storage: { root: '/after' } };
  expect(instance.get(spec.threadId, moved)).toBe(handle);
  expect(await instance.create({ ...spec, namespace: moved })).toBe(handle);
  await instance.close(spec.threadId, moved);
  expect(instance.get(spec.threadId, moved)).toBeUndefined();
});

it('retains storage isolation for namespaces without a stable owner', async () => {
  const instance = mountAgenetes({ drivers: { external: driver } });
  const namespace = { name: 'same-space', storage: { root: '/first' } };
  const spec = {
    kind: 'external',
    workloadType: 'Deployment' as const,
    namespace,
    threadId: 'legacy-thread',
    spec: {},
  };
  await instance.create(spec);
  const other = { ...namespace, storage: { root: '/second' } };
  await expect(instance.create({ ...spec, namespace: other })).rejects.toThrow(
    'another namespace',
  );
  expect(() => instance.get(spec.threadId, other)).toThrow('another namespace');
  await expect(instance.close(spec.threadId, other)).rejects.toThrow(
    'another namespace',
  );
  await instance.close(spec.threadId, namespace);
});

// A record written before namespaces had owners is found under its owner's
// namespace today, and the handle it realizes must live there too.
it('realizes an ownerless record under the namespace that found it', async () => {
  const threadStore = new InMemoryThreadStore();
  const legacy = {
    kind: 'external',
    workloadType: 'Deployment' as const,
    namespace: { name: 'space' },
    threadId: 'legacy-id',
    spec: {},
  };
  threadStore.upsert(legacy.namespace, legacy.threadId, {
    driverSchemaVersion: 1,
    spec: legacy,
    state: { driverState: {} },
  });
  const instance = mountAgenetes({
    drivers: { external: driver },
    threadStore,
  });
  const owned = { name: 'space', ownerId: 'workspace-a' };
  const handle = await instance.create({ ...legacy, namespace: owned });
  expect(instance.get('legacy-id', owned)).toBe(handle);
  await expect(instance.create({ ...legacy, namespace: owned })).resolves.toBe(
    handle,
  );
  await instance.close('legacy-id', owned);
  expect(instance.get('legacy-id', owned)).toBeUndefined();
});
