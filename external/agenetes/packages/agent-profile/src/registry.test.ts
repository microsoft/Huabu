import { describe, expect, it, vi } from 'vitest';

import { AgentProfileRegistry } from './registry.js';
import { InMemoryAgentProfileRegistryStore } from './store.js';

import type {
  CreateAgentProfileInput,
  PatchAgentProfileInput,
} from './types.js';

const input: CreateAgentProfileInput = {
  launchKind: 'acp-command',
  id: 'ordinary',
  alias: 'My agent',
  agentletId: 'machine-a',
  workingDirPath: '/work/custom',
  command: 'agent --acp',
  metadata: { cliId: 'custom' },
  customData: {
    icon: { shape: 'circle' },
    preference: ['model', null, 42, true],
  },
};

describe('AgentProfileRegistry', () => {
  it('persists hidden Profiles without selecting them and preserves legacy visibility', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = await AgentProfileRegistry.open(store);
    await registry.createProfile(input);
    await registry.createProfile({ ...input, id: 'hidden', visible: false });
    const restored = await AgentProfileRegistry.open(store);
    expect(await restored.listProfiles()).toHaveLength(2);
    expect((await restored.getProfile('hidden'))?.visible).toBe(false);
    expect(await restored.listSelectableProfileIds()).toEqual(['ordinary']);
    expect((await restored.snapshotProfile('hidden')).profileId).toBe('hidden');
  });
  it('persists structured launch separately from editable metadata and clones immutable snapshots', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = await AgentProfileRegistry.open(store);
    const created = await registry.createProfile({
      launchKind: 'acp-harness',
      id: 'harness',
      alias: 'Typed',
      agentletId: 'machine-a',
      workingDirPath: '/work',
      harnessId: 'copilot',
      options: { autoApprove: true },
      metadata: { cliId: 'claude' },
    });
    const expected = {
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: true },
    };
    expect(created.launch).toEqual(expected);
    const snapshot = await registry.snapshotProfile('harness');
    if (created.launch.kind === 'acp-harness')
      created.launch.options!.autoApprove = false;
    await registry.patchProfile('harness', { metadata: { cliId: 'custom' } });
    expect(await registry.snapshotProfile('harness')).toEqual(snapshot);
    expect(
      (await (await AgentProfileRegistry.open(store)).getProfile('harness'))
        ?.launch,
    ).toEqual(expected);
    await registry.patchProfile('harness', {
      launch: {
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: { autoApprove: false },
      },
    });
    expect(await registry.getProfile('harness')).toMatchObject({
      revision: 2,
      executionRevision: 1,
    });
    expect(snapshot.launch).toEqual(expected);
  });

  it.each([
    { autoApprove: 'yes' },
    { model: 'not-a-launch-option' },
    { argv: [] },
  ])('rejects unsupported harness options %j', async (options) => {
    const registry = await AgentProfileRegistry.open(
      new InMemoryAgentProfileRegistryStore(),
    );
    await expect(
      registry.createProfile({
        launchKind: 'acp-harness',
        alias: 'Invalid',
        agentletId: 'machine-a',
        workingDirPath: '/work',
        harnessId: 'copilot',
        options,
      } as CreateAgentProfileInput),
    ).rejects.toThrow();
    expect(await registry.listProfiles()).toEqual([]);
  });

  it('preserves immutable launch identity, opaque data and stable IDs through CRUD', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = await AgentProfileRegistry.open(store);
    const changed = vi.fn();
    const unsubscribe = registry.onChange(changed);
    const created = await registry.createProfile(input);
    expect(await registry.listSelectableProfileIds()).toEqual(['ordinary']);
    expect(created.customData).toEqual(input.customData);
    created.alias = 'not persisted';
    expect((await registry.getProfile('ordinary'))?.alias).toBe('My agent');
    const snapshot = await registry.snapshotProfile('ordinary');
    await registry.patchProfile('ordinary', {
      alias: 'Renamed',
      customData: { untouched: ' value ' },
    });
    expect(await registry.getProfile('ordinary')).toMatchObject({
      alias: 'Renamed',
      customData: { untouched: ' value ' },
      metadata: input.metadata,
    });
    expect(await registry.snapshotProfile('ordinary')).toEqual(snapshot);
    const restored = await AgentProfileRegistry.open(store);
    expect(await restored.getProfile('ordinary')).toEqual(
      await registry.getProfile('ordinary'),
    );
    await registry.patchProfile('ordinary', {
      metadata: null,
      customData: null,
    });
    expect(await registry.getProfile('ordinary')).not.toHaveProperty(
      'customData',
    );
    expect(await registry.getProfile('ordinary')).not.toHaveProperty(
      'metadata',
    );
    expect(await registry.deleteProfile('ordinary')).toBe(true);
    expect(await registry.deleteProfile('ordinary')).toBe(false);
    expect(snapshot.launch).toEqual({
      kind: 'acp-command',
      command: input.command,
    });
    expect(changed).toHaveBeenCalledTimes(4);
    unsubscribe();
    await registry.createProfile(input);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('imports atomically and fails explicitly for conflicting IDs', async () => {
    const registry = await AgentProfileRegistry.open(
      new InMemoryAgentProfileRegistryStore(),
    );
    expect(await registry.importCommandProfiles([input])).toEqual(['ordinary']);
    expect(await registry.importCommandProfiles([input])).toEqual(['ordinary']);
    await expect(
      registry.importCommandProfiles([
        { ...input, id: 'new' },
        { ...input, command: 'different' },
      ]),
    ).rejects.toThrow(expect.objectContaining({ code: 'profile_conflict' }));
    expect(await registry.listSelectableProfileIds()).toEqual(['ordinary']);
  });

  it('does not conflict on revision fields when importing an identical existing Profile', async () => {
    const registry = await AgentProfileRegistry.open(
      new InMemoryAgentProfileRegistryStore(),
    );
    await registry.createProfile(input);
    await registry.patchProfile('ordinary', { alias: 'Another alias' });
    await registry.patchProfile('ordinary', { alias: input.alias });
    expect(await registry.importCommandProfiles([input])).toEqual(['ordinary']);
    expect(await registry.getProfile('ordinary')).toMatchObject({
      revision: 2,
      executionRevision: 0,
    });
  });

  it('edits commands and cwd with revision fencing while preserving snapshots and opaque data', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = await AgentProfileRegistry.open(store);
    expect(await registry.createProfile(input)).toMatchObject({
      revision: 0,
      executionRevision: 0,
    });
    const snapshot = await registry.snapshotProfile('ordinary');
    const changed = vi.fn();
    const save = vi.spyOn(store, 'save');
    registry.onChange(changed);
    expect(
      await registry.patchProfile('ordinary', {
        expectedRevision: 0,
        alias: input.alias,
      }),
    ).toMatchObject({ revision: 0 });
    expect(save).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(
      await registry.patchProfile('ordinary', {
        expectedRevision: 0,
        workingDirPath: '/new',
        launch: { kind: 'acp-command', command: 'new-agent --acp' },
      }),
    ).toMatchObject({
      revision: 1,
      executionRevision: 1,
      customData: input.customData,
    });
    await expect(
      registry.patchProfile('ordinary', {
        expectedRevision: 0,
        alias: 'Stale',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'profile_conflict' }));
    await expect(
      registry.patchProfile('ordinary', { expectedRevision: 0 }),
    ).rejects.toThrow(expect.objectContaining({ code: 'profile_conflict' }));
    expect(
      await registry.patchProfile('ordinary', {
        expectedRevision: 1,
        alias: 'Fresh',
      }),
    ).toMatchObject({ revision: 2, executionRevision: 1 });
    expect(snapshot).toEqual({
      profileId: 'ordinary',
      agentletId: input.agentletId,
      workingDirPath: input.workingDirPath,
      launch: { kind: 'acp-command', command: input.command },
      executionRevision: 0,
    });
    snapshot.launch = { kind: 'acp-command', command: 'mutated snapshot' };
    expect((await registry.getProfile('ordinary'))?.launch).toEqual({
      kind: 'acp-command',
      command: 'new-agent --acp',
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('loads legacy revisions without migrating and treats absence as zero', async () => {
    const original = {
      id: 'legacy',
      alias: 'Legacy',
      agentletId: 'machine-a',
      workingDirPath: '/work',
      launch: { kind: 'acp-command' as const, command: 'agent' },
    };
    const store = new InMemoryAgentProfileRegistryStore({
      profiles: [original],
    });
    const save = vi.spyOn(store, 'save');
    const registry = await AgentProfileRegistry.open(store);
    expect(await registry.getProfile('legacy')).toEqual(original);
    expect(await registry.snapshotProfile('legacy')).not.toHaveProperty(
      'executionRevision',
    );
    expect(
      await registry.patchProfile('legacy', { expectedRevision: 0 }),
    ).toEqual(original);
    expect(save).not.toHaveBeenCalled();
    expect(
      await registry.patchProfile('legacy', {
        expectedRevision: 0,
        workingDirPath: '/other',
      }),
    ).toMatchObject({ revision: 1, executionRevision: 1 });
  });

  it('rejects wrapper/machine switching and malformed revision guards', async () => {
    const registry = await AgentProfileRegistry.open(
      new InMemoryAgentProfileRegistryStore(),
    );
    await registry.createProfile(input);
    await registry.createProfile({
      launchKind: 'acp-harness',
      id: 'typed',
      alias: 'Typed',
      agentletId: 'machine-a',
      workingDirPath: '/work',
      harnessId: 'copilot',
    });
    for (const [id, patch] of [
      ['ordinary', { agentletId: 'machine-b' }],
      ['ordinary', { launch: { kind: 'acp-harness', harnessId: 'copilot' } }],
      ['typed', { launch: { kind: 'acp-harness', harnessId: 'claude' } }],
      ['typed', { launch: { kind: 'acp-command', command: 'agent' } }],
      ['ordinary', { expectedRevision: -1 }],
      ['ordinary', { expectedRevision: 0.5 }],
      ['ordinary', { expectedRevision: '0' }],
    ] as const) {
      await expect(
        registry.patchProfile(id, patch as unknown as PatchAgentProfileInput),
      ).rejects.toThrow(
        expect.objectContaining({ code: 'invalid_profile_patch' }),
      );
    }
  });

  it('does not mutate memory or notify listeners when persistence fails', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = await AgentProfileRegistry.open(store);
    const changed = vi.fn();
    registry.onChange(changed);
    vi.spyOn(store, 'save').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(registry.createProfile(input)).rejects.toThrow('disk full');
    expect(await registry.listProfiles()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('runs concurrent mutations in order against acknowledged state', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const save = store.save.bind(store);
    const saved: string[][] = [];
    vi.spyOn(store, 'save').mockImplementation(async (state) => {
      // Acknowledge on a later macrotask, as a database round trip would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      saved.push(state.profiles.map(({ id }) => id));
      await save(state);
    });
    const registry = await AgentProfileRegistry.open(store);
    const failed = registry.patchProfile('missing', { alias: 'x' });
    await Promise.all([
      registry.createProfile(input),
      registry.createProfile({ ...input, id: 'second' }),
      expect(failed).rejects.toThrow('not found'),
      registry.patchProfile('second', { alias: 'Renamed' }),
    ]);
    expect(saved).toEqual([
      ['ordinary'],
      ['ordinary', 'second'],
      ['ordinary', 'second'],
    ]);
    expect(
      (await (await AgentProfileRegistry.open(store)).getProfile('second'))
        ?.alias,
    ).toBe('Renamed');
  });

  it('validates ordinary inputs and isolates failing subscribers', async () => {
    const registry = await AgentProfileRegistry.open(
      new InMemoryAgentProfileRegistryStore(),
    );
    const failure = new Error('listener failed');
    const onError = vi.fn();
    registry.onChange(() => {
      throw failure;
    }, onError);
    await registry.createProfile(input);
    expect(onError).toHaveBeenCalledWith(failure);
    await expect(registry.createProfile(input)).rejects.toThrow(
      expect.objectContaining({ code: 'profile_conflict' }),
    );
    await expect(registry.patchProfile('missing', {})).rejects.toThrow(
      expect.objectContaining({ code: 'profile_not_found' }),
    );
    await expect(
      registry.createProfile({ ...input, id: 'bad', command: ' ' }),
    ).rejects.toThrow();
  });
});

it('applies host ownership to reads and mutations without discarding other owners', async () => {
  const store = new InMemoryAgentProfileRegistryStore();
  const all = await AgentProfileRegistry.open(store);
  await all.createProfile({
    ...input,
    id: 'alice',
    agentletId: 'alice-device',
  });
  await all.createProfile({ ...input, id: 'bob', agentletId: 'bob-device' });
  const alice = await AgentProfileRegistry.open(store, {
    resolveAccess: () => (profile) => profile.agentletId === 'alice-device',
  });
  expect((await alice.listProfiles()).map((p) => p.id)).toEqual(['alice']);
  expect(await alice.listSelectableProfileIds()).toEqual(['alice']);
  expect(await alice.getProfile('bob')).toBeUndefined();
  await expect(alice.snapshotProfile('bob')).rejects.toThrow('not found');
  await expect(alice.patchProfile('bob', { alias: 'Stolen' })).rejects.toThrow(
    'not found',
  );
  expect(await alice.deleteProfile('bob')).toBe(false);
  await expect(
    alice.createProfile({
      ...input,
      id: 'stolen',
      agentletId: 'bob-device',
    }),
  ).rejects.toThrow('unavailable');
  await expect(
    alice.createProfile({
      ...input,
      id: 'bob',
      agentletId: 'alice-device',
    }),
  ).rejects.toThrow('already exists');
  await expect(
    alice.importCommandProfiles([
      { ...input, id: 'bob', agentletId: 'alice-device' },
    ]),
  ).rejects.toThrow('already exists');
  await alice.importCommandProfiles([
    { ...input, id: 'alice-two', agentletId: 'alice-device' },
  ]);
  expect(
    (await (await AgentProfileRegistry.open(store)).listProfiles()).map(
      (p) => p.id,
    ),
  ).toEqual(['alice', 'bob', 'alice-two']);
});

it('resolves host access once per read or mutation, whatever the number of Profiles', async () => {
  const store = new InMemoryAgentProfileRegistryStore();
  const all = await AgentProfileRegistry.open(store);
  for (const id of ['one', 'two', 'three'])
    await all.createProfile({ ...input, id });
  const resolveAccess = vi.fn(async () => () => true);
  const registry = await AgentProfileRegistry.open(store, { resolveAccess });

  await registry.listProfiles();
  expect(resolveAccess).toHaveBeenCalledTimes(1);
  await registry.listSelectableProfileIds();
  await registry.getProfile('two');
  await registry.snapshotProfile('three');
  expect(resolveAccess).toHaveBeenCalledTimes(4);
  await registry.importCommandProfiles([
    { ...input, id: 'four' },
    { ...input, id: 'five' },
  ]);
  await registry.patchProfile('one', { alias: 'Renamed' });
  expect(resolveAccess).toHaveBeenCalledTimes(6);
});
