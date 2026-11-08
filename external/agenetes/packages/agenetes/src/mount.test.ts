import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineDriver } from '@agenetes/runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { mountAgenetes } from './mount.js';
import { FileThreadStore } from './thread-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A persisted location may contain an old/foreign owner; defaults partition in memory. */
function fileBacking() {
  const root = mkdtempSync(join(tmpdir(), 'agenetes-mount-owner-'));
  roots.push(root);
  return { threadStore: new FileThreadStore(), storage: { root } };
}

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

// A guessed logical ID may create another conversation, never reuse or
// tear down the original namespace's handle.
it.each([
  ['carol', 'erin'],
  ['erin', 'carol'],
])(
  'keeps colliding thread IDs independent from %s to %s',
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
    expect(instance.get('shared-id', { name: second })).toBeUndefined();
    await instance.close('shared-id', { name: second });
    expect(instance.get('shared-id', spec.namespace)).toBe(handle);
    const other = await instance.create({
      ...spec,
      namespace: { name: second },
    });
    expect(other).not.toBe(handle);
    expect(instance.get('shared-id', { name: second })).toBe(other);
    expect(() => instance.get('shared-id')).toThrow('ambiguous');
    await expect(instance.close('shared-id')).rejects.toThrow('ambiguous');
    expect(await instance.create(spec)).toBe(handle);
    await instance.close('shared-id', spec.namespace);
    expect(instance.get('shared-id')).toBe(other);
    await instance.close('shared-id');
  },
);

it('creates colliding logical IDs concurrently in distinct namespaces', async () => {
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
    'fulfilled',
  ]);
});

it('refuses a live thread from another owner at the same persisted location', async () => {
  const { threadStore, storage } = fileBacking();
  const instance = mountAgenetes({
    drivers: { external: driver },
    threadStore,
  });
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
  await expect(instance.create({ ...spec, namespace: other })).rejects.toThrow(
    'another namespace',
  );
  expect(instance.get(spec.threadId, other)).toBeUndefined();
  await instance.close(spec.threadId, other);
  expect(instance.get(spec.threadId, namespace)).toBe(handle);
  await instance.close(spec.threadId, namespace);
});

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

it('keeps ownerless namespaces with different storage from aliasing handles', async () => {
  const instance = mountAgenetes({ drivers: { external: driver } });
  const namespace = { name: 'same-space', storage: { root: '/first' } };
  const spec = {
    kind: 'external',
    workloadType: 'Deployment' as const,
    namespace,
    threadId: 'legacy-thread',
    spec: {},
  };
  const first = await instance.create(spec);
  const other = { ...namespace, storage: { root: '/second' } };
  expect(instance.get(spec.threadId, other)).toBeUndefined();
  await instance.close(spec.threadId, other);
  expect(instance.get(spec.threadId, namespace)).toBe(first);
  const second = await instance.create({ ...spec, namespace: other });
  expect(second).not.toBe(first);
  expect(instance.get(spec.threadId, namespace)).toBe(first);
  expect(instance.get(spec.threadId, other)).toBe(second);
  await instance.close(spec.threadId, other);
  expect(instance.get(spec.threadId)).toBe(first);
  await instance.close(spec.threadId, namespace);
});

// A record written before namespaces had owners is found under its owner's
// namespace today, and the handle it realizes must live there too.
it('realizes an ownerless record under the namespace that found it', async () => {
  const { threadStore, storage } = fileBacking();
  const legacy = {
    kind: 'external',
    workloadType: 'Deployment' as const,
    namespace: { name: 'space', storage },
    threadId: 'legacy-id',
    spec: {},
  };
  threadStore.upsert(legacy.namespace, legacy.threadId, {
    driverSchemaVersion: 1,
    spec: legacy,
    state: { driverState: {} },
    hostMetadata: { legacyProof: true },
  });
  const instance = mountAgenetes({
    drivers: { external: driver },
    threadStore,
  });
  const owned = { ...legacy.namespace, ownerId: 'workspace-a' };
  const handle = await instance.create({ ...legacy, namespace: owned });
  expect(instance.get('legacy-id', owned)).toBe(handle);
  expect((await instance.record(owned, 'legacy-id'))?.hostMetadata).toEqual({
    legacyProof: true,
  });
  await expect(instance.create({ ...legacy, namespace: owned })).resolves.toBe(
    handle,
  );
  await instance.close('legacy-id', owned);
  expect(instance.get('legacy-id', owned)).toBeUndefined();
});

// Ownership is the record's, not only the live handle's: after a close or a
// restart, another owner's namespace of the same name must not reuse it.
it('refuses another owner a closed thread at the same persisted location after restart', async () => {
  const { threadStore, storage } = fileBacking();
  const instance = mountAgenetes({
    drivers: { external: driver },
    threadStore,
  });
  const spec = (ownerId: string) => ({
    kind: 'external',
    workloadType: 'Deployment' as const,
    namespace: {
      name: 'same-space',
      ownerId,
      ...(storage ? { storage } : {}),
    },
    threadId: 'closed-id',
    spec: {},
  });
  await instance.create(spec('workspace-a'));
  await instance.close('closed-id', spec('workspace-a').namespace);

  await expect(instance.create(spec('workspace-b'))).rejects.toThrow(
    'another namespace',
  );
  expect(
    instance.get('closed-id', spec('workspace-b').namespace),
  ).toBeUndefined();
  // A restart forgets live handles, not owners.
  const restarted = mountAgenetes({
    drivers: { external: driver },
    threadStore,
  });
  await expect(restarted.create(spec('workspace-b'))).rejects.toThrow(
    'another namespace',
  );
  await expect(restarted.create(spec('workspace-a'))).resolves.toBeDefined();
});
