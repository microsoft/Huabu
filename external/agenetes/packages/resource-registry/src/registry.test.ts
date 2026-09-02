import { describe, expect, it } from 'vitest';

import { ResourceRegistryError } from './errors.js';
import { ResourceRegistry } from './registry.js';
import { InMemoryResourceRegistryStore } from './store.js';

import type { AgentResource } from '@agenetes/protocol';

function resource(overrides: Partial<AgentResource> = {}): AgentResource {
  return {
    schemaVersion: 2,
    id: 'huabu-access',
    name: 'Huabu Access',
    provider: 'huabu',
    sourceContent: 'Fetch $HUABU_RFS_URL/skill with the injected token.',
    userContent: '',
    ...overrides,
  };
}

describe('ResourceRegistry', () => {
  it('lists registered resources sorted stably by id', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource({ id: 'web-search', name: 'Web Search' }));
    registry.register(resource({ id: 'huabu-access' }));
    registry.register(
      resource({ id: 'generate-image', name: 'Generate Image' }),
    );

    expect(registry.list().map((r) => r.id)).toEqual([
      'generate-image',
      'huabu-access',
      'web-search',
    ]);
  });

  it('returns undefined for an unknown id from get()', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    expect(registry.get('missing')).toBeUndefined();
  });

  it('registers and retrieves a resource', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    const created = registry.register(resource());
    expect(created).toEqual(resource());
    expect(registry.get('huabu-access')).toEqual(resource());
  });

  it('rejects malformed resources at the service boundary', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());

    expect(() => registry.register(resource({ id: 'Not Kebab Case' }))).toThrow(
      'not a valid AgentResource',
    );
  });

  it('rejects registering an id that already exists, even for the same provider', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource());

    expect(() => registry.register(resource())).toThrow(ResourceRegistryError);
    try {
      registry.register(resource());
    } catch (error) {
      expect((error as ResourceRegistryError).code).toBe('resource_conflict');
    }
  });

  it('rejects registering an id already owned by a different provider', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource({ provider: 'huabu' }));

    expect(() =>
      registry.register(resource({ provider: 'machine-a' })),
    ).toThrow('already registered');
  });

  it('replaces an existing record owned by the same provider', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource({ sourceContent: 'v1' }));

    const replaced = registry.replaceOwn(
      'huabu',
      resource({ sourceContent: 'v2' }),
    );

    expect(replaced.sourceContent).toBe('v2');
    expect(registry.get('huabu-access')?.sourceContent).toBe('v2');
  });

  it('atomically reconciles a provider projection and withdraws stale records', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource({ id: 'stale' }));
    registry.register(
      resource({
        id: 'machine-resource',
        provider: 'machine-a',
      }),
    );

    registry.replaceProviderResources('huabu', [
      resource({ id: 'huabu-access', sourceContent: 'Current' }),
    ]);

    expect(registry.list().map(({ id }) => id)).toEqual([
      'huabu-access',
      'machine-resource',
    ]);
  });

  it('preserves user customization during provider reconciliation', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(
      resource({
        displayName: 'My Huabu',
        userContent: 'Use concise notes.',
      }),
    );

    registry.replaceProviderResources('huabu', [
      resource({ sourceContent: 'Updated source' }),
    ]);

    expect(registry.get('huabu-access')).toMatchObject({
      sourceContent: 'Updated source',
      displayName: 'My Huabu',
      userContent: 'Use concise notes.',
    });
  });

  it('rejects replaceOwn for an unregistered id', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());

    expect(() => registry.replaceOwn('huabu', resource())).toThrow(
      ResourceRegistryError,
    );
    try {
      registry.replaceOwn('huabu', resource());
    } catch (error) {
      expect((error as ResourceRegistryError).code).toBe('resource_not_found');
    }
  });

  it('rejects replaceOwn from a provider that does not own the record', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource({ provider: 'huabu' }));

    expect(() =>
      registry.replaceOwn('machine-a', resource({ provider: 'huabu' })),
    ).toThrow(ResourceRegistryError);
    try {
      registry.replaceOwn('machine-a', resource({ provider: 'huabu' }));
    } catch (error) {
      expect((error as ResourceRegistryError).code).toBe('resource_conflict');
    }
  });

  it('rejects replaceOwn attempting to change the provider field', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource({ provider: 'huabu' }));

    expect(() =>
      registry.replaceOwn('huabu', resource({ provider: 'machine-a' })),
    ).toThrow('provider cannot change');
  });

  it('withdraws a record owned by the calling provider', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource());

    registry.withdraw('huabu', 'huabu-access');

    expect(registry.get('huabu-access')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('rejects withdraw for an unregistered id', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    expect(() => registry.withdraw('huabu', 'missing')).toThrow(
      ResourceRegistryError,
    );
  });

  it('rejects withdraw from a provider that does not own the record', () => {
    const registry = new ResourceRegistry(new InMemoryResourceRegistryStore());
    registry.register(resource({ provider: 'huabu' }));

    expect(() => registry.withdraw('machine-a', 'huabu-access')).toThrow(
      ResourceRegistryError,
    );
  });

  it('does not cascade withdrawal side effects beyond the catalogue', () => {
    const store = new InMemoryResourceRegistryStore();
    const registry = new ResourceRegistry(store);
    registry.register(resource({ id: 'a' }));
    registry.register(resource({ id: 'b', name: 'B' }));

    registry.withdraw('huabu', 'a');

    expect(registry.list().map((r) => r.id)).toEqual(['b']);
    expect(store.load().resources.map((r) => r.id)).toEqual(['b']);
  });

  it('persists mutations through the injected store', () => {
    const store = new InMemoryResourceRegistryStore();
    const registry = new ResourceRegistry(store);
    registry.register(resource());

    // A second registry instance reading the same store observes the change.
    const reopened = new ResourceRegistry(store);
    expect(reopened.get('huabu-access')).toEqual(resource());
  });
});
