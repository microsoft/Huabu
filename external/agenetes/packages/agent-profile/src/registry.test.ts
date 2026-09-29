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
  it('persists structured launch separately from editable metadata and clones immutable snapshots', () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = new AgentProfileRegistry(store);
    const created = registry.createProfile({
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
    registry.patchProfile('harness', { metadata: { cliId: 'custom' } });
    expect(registry.snapshotProfile('harness')).toEqual(snapshot);
    expect(
      new AgentProfileRegistry(store).getProfile('harness')?.launch,
    ).toEqual(expected);
    registry.patchProfile('harness', {
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
  ])('rejects unsupported harness options %j', (options) => {
    const registry = new AgentProfileRegistry(
      new InMemoryAgentProfileRegistryStore(),
    );
    expect(() =>
      registry.createProfile({
        launchKind: 'acp-harness',
        alias: 'Invalid',
        agentletId: 'machine-a',
        workingDirPath: '/work',
        harnessId: 'copilot',
        options,
      } as CreateAgentProfileInput),
    ).toThrow();
    expect(registry.listProfiles()).toEqual([]);
  });

  it('preserves immutable launch identity, opaque data and stable IDs through CRUD', () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = new AgentProfileRegistry(store);
    const changed = vi.fn();
    const unsubscribe = registry.onChange(changed);
    const created = registry.createProfile(input);
    expect(registry.listSelectableProfileIds()).toEqual(['ordinary']);
    expect(created.customData).toEqual(input.customData);
    created.alias = 'not persisted';
    expect(registry.getProfile('ordinary')?.alias).toBe('My agent');
    const snapshot = registry.snapshotProfile('ordinary');
    registry.patchProfile('ordinary', {
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
    registry.patchProfile('ordinary', { metadata: null, customData: null });
    expect(registry.getProfile('ordinary')).not.toHaveProperty('customData');
    expect(registry.getProfile('ordinary')).not.toHaveProperty('metadata');
    expect(registry.deleteProfile('ordinary')).toBe(true);
    expect(registry.deleteProfile('ordinary')).toBe(false);
    expect(snapshot.launch).toEqual({
      kind: 'acp-command',
      command: input.command,
    });
    expect(changed).toHaveBeenCalledTimes(4);
    unsubscribe();
    registry.createProfile(input);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('imports atomically and fails explicitly for conflicting IDs', () => {
    const registry = new AgentProfileRegistry(
      new InMemoryAgentProfileRegistryStore(),
    );
    expect(registry.importCommandProfiles([input])).toEqual(['ordinary']);
    expect(registry.importCommandProfiles([input])).toEqual(['ordinary']);
    expect(() =>
      registry.importCommandProfiles([
        { ...input, id: 'new' },
        { ...input, command: 'different' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'profile_conflict' }));
    expect(registry.listSelectableProfileIds()).toEqual(['ordinary']);
  });

  it('does not conflict on revision fields when importing an identical existing Profile', () => {
    const registry = new AgentProfileRegistry(
      new InMemoryAgentProfileRegistryStore(),
    );
    registry.createProfile(input);
    registry.patchProfile('ordinary', { alias: 'Another alias' });
    registry.patchProfile('ordinary', { alias: input.alias });
    expect(registry.importCommandProfiles([input])).toEqual(['ordinary']);
    expect(registry.getProfile('ordinary')).toMatchObject({
      revision: 2,
      executionRevision: 0,
    });
  });

  it('edits commands and cwd with revision fencing while preserving snapshots and opaque data', () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = new AgentProfileRegistry(store);
    expect(registry.createProfile(input)).toMatchObject({
      revision: 0,
      executionRevision: 0,
    });
    const snapshot = registry.snapshotProfile('ordinary');
    const changed = vi.fn();
    const save = vi.spyOn(store, 'save');
    registry.onChange(changed);
    expect(
      registry.patchProfile('ordinary', {
        expectedRevision: 0,
        alias: input.alias,
      }),
    ).toMatchObject({ revision: 0 });
    expect(save).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(
      registry.patchProfile('ordinary', {
        expectedRevision: 0,
        workingDirPath: '/new',
        launch: { kind: 'acp-command', command: 'new-agent --acp' },
      }),
    ).toMatchObject({
      revision: 1,
      executionRevision: 1,
      customData: input.customData,
    });
    expect(() =>
      registry.patchProfile('ordinary', {
        expectedRevision: 0,
        alias: 'Stale',
      }),
    ).toThrow(expect.objectContaining({ code: 'profile_conflict' }));
    expect(() =>
      registry.patchProfile('ordinary', { expectedRevision: 0 }),
    ).toThrow(expect.objectContaining({ code: 'profile_conflict' }));
    expect(
      registry.patchProfile('ordinary', {
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

  it('loads legacy revisions without migrating and treats absence as zero', () => {
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
    expect(registry.patchProfile('legacy', { expectedRevision: 0 })).toEqual(
      original,
    );
    expect(save).not.toHaveBeenCalled();
    expect(
      registry.patchProfile('legacy', {
        expectedRevision: 0,
        workingDirPath: '/other',
      }),
    ).toMatchObject({ revision: 1, executionRevision: 1 });
  });

  it('rejects wrapper/machine switching and malformed revision guards', () => {
    const registry = new AgentProfileRegistry(
      new InMemoryAgentProfileRegistryStore(),
    );
    registry.createProfile(input);
    registry.createProfile({
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
      expect(() =>
        registry.patchProfile(id, patch as unknown as PatchAgentProfileInput),
      ).toThrow(expect.objectContaining({ code: 'invalid_profile_patch' }));
    }
  });

  it('does not mutate memory or notify listeners when persistence fails', () => {
    const store = new InMemoryAgentProfileRegistryStore();
    const registry = new AgentProfileRegistry(store);
    const changed = vi.fn();
    registry.onChange(changed);
    vi.spyOn(store, 'save').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => registry.createProfile(input)).toThrow('disk full');
    expect(registry.listProfiles()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('validates ordinary inputs and isolates failing subscribers', () => {
    const registry = new AgentProfileRegistry(
      new InMemoryAgentProfileRegistryStore(),
    );
    const failure = new Error('listener failed');
    const onError = vi.fn();
    registry.onChange(() => {
      throw failure;
    }, onError);
    registry.createProfile(input);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(() => registry.createProfile(input)).toThrow(
      expect.objectContaining({ code: 'profile_conflict' }),
    );
    expect(() => registry.patchProfile('missing', {})).toThrow(
      expect.objectContaining({ code: 'profile_not_found' }),
    );
    expect(() =>
      registry.createProfile({ ...input, id: 'bad', command: ' ' }),
    ).toThrow();
  });
});
