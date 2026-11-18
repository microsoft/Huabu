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
    const registry = new AgentProfileRegistry(store);
    await registry.createProfile(input);
    await registry.createProfile({ ...input, id: 'hidden', visible: false });
    const restored = new AgentProfileRegistry(store);
    expect(restored.listProfiles()).toHaveLength(2);
    expect(restored.getProfile('hidden')?.visible).toBe(false);
    expect(restored.listSelectableProfileIds()).toEqual(['ordinary']);
    expect(restored.snapshotProfile('hidden').profileId).toBe('hidden');
  });
  it('persists structured launch separately from editable metadata and clones immutable snapshots', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = new AgentProfileRegistry(store);
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
    const snapshot = registry.snapshotProfile('harness');
    if (created.launch.kind === 'acp-harness')
      created.launch.options!.autoApprove = false;
    await registry.patchProfile('harness', { metadata: { cliId: 'custom' } });
    expect(registry.snapshotProfile('harness')).toEqual(snapshot);
    expect(
      new AgentProfileRegistry(store).getProfile('harness')?.launch,
    ).toEqual(expected);
    await registry.patchProfile('harness', {
      launch: {
        kind: 'acp-harness',
        harnessId: 'copilot',
        options: { autoApprove: false },
      },
    });
    expect(registry.getProfile('harness')).toMatchObject({
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
    const registry = new AgentProfileRegistry(
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
    expect(registry.listProfiles()).toEqual([]);
  });

  it('preserves immutable launch identity, opaque data and stable IDs through CRUD', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = new AgentProfileRegistry(store);
    const changed = vi.fn();
    const unsubscribe = registry.onChange(changed);
    const created = await registry.createProfile(input);
    expect(registry.listSelectableProfileIds()).toEqual(['ordinary']);
    expect(created.customData).toEqual(input.customData);
    created.alias = 'not persisted';
    expect(registry.getProfile('ordinary')?.alias).toBe('My agent');
    const snapshot = registry.snapshotProfile('ordinary');
    await registry.patchProfile('ordinary', {
      alias: 'Renamed',
      customData: { untouched: ' value ' },
    });
    expect(registry.getProfile('ordinary')).toMatchObject({
      alias: 'Renamed',
      customData: { untouched: ' value ' },
      metadata: input.metadata,
    });
    expect(registry.snapshotProfile('ordinary')).toEqual(snapshot);
    const restored = new AgentProfileRegistry(store);
    expect(restored.getProfile('ordinary')).toEqual(
      registry.getProfile('ordinary'),
    );
    await registry.patchProfile('ordinary', {
      metadata: null,
      customData: null,
    });
    expect(registry.getProfile('ordinary')).not.toHaveProperty('customData');
    expect(registry.getProfile('ordinary')).not.toHaveProperty('metadata');
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
    const registry = new AgentProfileRegistry(
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
    expect(registry.listSelectableProfileIds()).toEqual(['ordinary']);
  });

  it('does not conflict on revision fields when importing an identical existing Profile', async () => {
    const registry = new AgentProfileRegistry(
      new InMemoryAgentProfileRegistryStore(),
    );
    await registry.createProfile(input);
    await registry.patchProfile('ordinary', { alias: 'Another alias' });
    await registry.patchProfile('ordinary', { alias: input.alias });
    expect(await registry.importCommandProfiles([input])).toEqual(['ordinary']);
    expect(registry.getProfile('ordinary')).toMatchObject({
      revision: 2,
      executionRevision: 0,
    });
  });

  it('edits commands and cwd with revision fencing while preserving snapshots and opaque data', async () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = new AgentProfileRegistry(store);
    expect(await registry.createProfile(input)).toMatchObject({
      revision: 0,
      executionRevision: 0,
    });
    const snapshot = registry.snapshotProfile('ordinary');
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
    expect(registry.getProfile('ordinary')?.launch).toEqual({
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
    const registry = new AgentProfileRegistry(store);
    expect(registry.getProfile('legacy')).toEqual(original);
    expect(registry.snapshotProfile('legacy')).not.toHaveProperty(
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
    const registry = new AgentProfileRegistry(
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
    const registry = new AgentProfileRegistry(store);
    const changed = vi.fn();
    registry.onChange(changed);
    vi.spyOn(store, 'save').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(registry.createProfile(input)).rejects.toThrow('disk full');
    expect(registry.listProfiles()).toEqual([]);
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
    const registry = new AgentProfileRegistry(store);
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
    expect(new AgentProfileRegistry(store).getProfile('second')?.alias).toBe(
      'Renamed',
    );
  });

  it('validates ordinary inputs and isolates failing subscribers', async () => {
    const registry = new AgentProfileRegistry(
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
  const all = new AgentProfileRegistry(store);
  await all.createProfile({
    ...input,
    id: 'alice',
    agentletId: 'alice-device',
  });
  await all.createProfile({ ...input, id: 'bob', agentletId: 'bob-device' });
  const alice = new AgentProfileRegistry(
    store,
    undefined,
    (profile) => profile.agentletId === 'alice-device',
  );
  expect(alice.listProfiles().map((p) => p.id)).toEqual(['alice']);
  expect(alice.listSelectableProfileIds()).toEqual(['alice']);
  expect(alice.getProfile('bob')).toBeUndefined();
  expect(() => alice.snapshotProfile('bob')).toThrow('not found');
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
    new AgentProfileRegistry(store).listProfiles().map((p) => p.id),
  ).toEqual(['alice', 'bob', 'alice-two']);
});
