import { describe, expect, it, vi } from 'vitest';

import { AgentProfileRegistry } from './registry.js';
import { InMemoryAgentProfileRegistryStore } from './store.js';

import type { CreateAgentProfileInput } from './types.js';

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
