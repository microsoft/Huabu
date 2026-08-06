import { describe, expect, it, vi } from 'vitest';

import { AgentTeamRegistry } from './registry.js';
import { agentTeamMemberSecretId } from './secret-id.js';
import { InMemoryAgentTeamRegistryStore } from './store.js';

import type { AgentTeamRegistryState, AgentTeamSecretStore } from './types.js';
import type { AgentTeamScanResult } from '@agentlet/protocol';

class MemorySecretStore implements AgentTeamSecretStore {
  readonly values = new Map<string, string>();

  get(id: string): string | null {
    return this.values.get(id) ?? null;
  }

  async setMany(updates: Record<string, string | null>): Promise<void> {
    for (const [id, value] of Object.entries(updates)) {
      if (value === null) this.values.delete(id);
      else this.values.set(id, value);
    }
  }
}

class FailingRegistryStore extends InMemoryAgentTeamRegistryStore {
  failWrites = false;

  override save(state: AgentTeamRegistryState): void {
    if (this.failWrites) throw new Error('registry write failed');
    super.save(state);
  }
}

const machine = 'machine-a';
const manifestPath = '/teams/reviewer/agentlet.yaml';
const root = { machine, path: '/teams' };
const scanResult: AgentTeamScanResult = {
  rootPath: root.path,
  members: [
    {
      name: 'reviewer',
      manifestPath,
      description: 'Reviews changes',
      harnesses: ['copilot'],
      env: [
        {
          name: 'MODEL',
          description: 'Model name',
          required: false,
          secret: false,
          default: 'gpt-5',
        },
        {
          name: 'ENDPOINT',
          description: 'Service endpoint',
          required: true,
          secret: false,
        },
        {
          name: 'TOKEN',
          description: 'Service token',
          required: true,
          secret: true,
        },
      ],
    },
  ],
  diagnostics: [],
};

async function createRegistry(options?: {
  store?: InMemoryAgentTeamRegistryStore;
  secrets?: MemorySecretStore;
}): Promise<{
  registry: AgentTeamRegistry;
  store: InMemoryAgentTeamRegistryStore;
  secrets: MemorySecretStore;
}> {
  const store = options?.store ?? new InMemoryAgentTeamRegistryStore();
  const secrets = options?.secrets ?? new MemorySecretStore();
  const registry = new AgentTeamRegistry(
    store,
    { scanAgentTeams: async () => structuredClone(scanResult) },
    Date.now,
    undefined,
    secrets,
  );
  await registry.addRoot(root);
  return { registry, store, secrets };
}

describe('Agent Team member Configs', () => {
  it('notifies subscribers after a secret-only update', async () => {
    const { registry } = await createRegistry();
    const handler = vi.fn();
    registry.onChange(handler, vi.fn());

    await registry.updateMemberConfigs(machine, manifestPath, {
      TOKEN: 'secret',
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates subscriber failures from secret persistence', async () => {
    const { registry } = await createRegistry();
    const subscriberError = new Error('subscriber failed');
    const onError = vi.fn();
    registry.onChange(() => {
      throw subscriberError;
    }, onError);

    await expect(
      registry.updateMemberConfigs(machine, manifestPath, {
        TOKEN: 'secret',
      }),
    ).resolves.toMatchObject({ ready: false });

    expect(onError).toHaveBeenCalledWith(subscriberError);
    expect(
      registry
        .getMemberConfig(machine, manifestPath)
        .fields.find((field) => field.name === 'TOKEN'),
    ).toMatchObject({ configured: true });
  });

  it('combines defaults and overrides while redacting secret values', async () => {
    const { registry, store } = await createRegistry();

    expect(registry.getMemberConfig(machine, manifestPath)).toEqual({
      machine,
      manifestPath,
      fields: [
        {
          name: 'MODEL',
          description: 'Model name',
          required: false,
          secret: false,
          configured: true,
          value: 'gpt-5',
        },
        {
          name: 'ENDPOINT',
          description: 'Service endpoint',
          required: true,
          secret: false,
          configured: false,
        },
        {
          name: 'TOKEN',
          description: 'Service token',
          required: true,
          secret: true,
          configured: false,
        },
      ],
      missingRequired: ['ENDPOINT', 'TOKEN'],
      ready: false,
    });

    const view = await registry.updateMemberConfigs(machine, manifestPath, {
      ENDPOINT: 'https://example.test',
      TOKEN: 'private-token',
    });

    expect(view).toMatchObject({
      ready: true,
      missingRequired: [],
      fields: [
        expect.objectContaining({ name: 'MODEL', value: 'gpt-5' }),
        expect.objectContaining({
          name: 'ENDPOINT',
          value: 'https://example.test',
        }),
        {
          name: 'TOKEN',
          description: 'Service token',
          required: true,
          secret: true,
          configured: true,
        },
      ],
    });
    expect(JSON.stringify(store.load())).not.toContain('private-token');
    expect(registry.resolveMemberEnvironment(machine, manifestPath)).toEqual({
      MODEL: 'gpt-5',
      ENDPOINT: 'https://example.test',
      TOKEN: 'private-token',
    });
  });

  it('clears values with null and restores non-secret defaults', async () => {
    const { registry } = await createRegistry();
    await registry.updateMemberConfigs(machine, manifestPath, {
      MODEL: 'custom-model',
      ENDPOINT: 'https://example.test',
      TOKEN: 'private-token',
    });

    const view = await registry.updateMemberConfigs(machine, manifestPath, {
      MODEL: null,
      TOKEN: null,
    });

    expect(view.fields).toEqual([
      expect.objectContaining({ name: 'MODEL', value: 'gpt-5' }),
      expect.objectContaining({
        name: 'ENDPOINT',
        value: 'https://example.test',
      }),
      expect.objectContaining({
        name: 'TOKEN',
        configured: false,
      }),
    ]);
    expect(view.missingRequired).toEqual(['TOKEN']);
  });

  it('rejects undeclared fields without changing either store', async () => {
    const { registry, store, secrets } = await createRegistry();
    const before = store.load();

    await expect(
      registry.updateMemberConfigs(machine, manifestPath, {
        UNKNOWN: 'value',
      }),
    ).rejects.toThrow('does not declare');

    expect(store.load()).toEqual(before);
    expect(secrets.values.size).toBe(0);
  });

  it('rolls secrets back when ordinary persistence fails', async () => {
    const store = new FailingRegistryStore();
    const secrets = new MemorySecretStore();
    const { registry } = await createRegistry({ store, secrets });
    const secretId = agentTeamMemberSecretId(machine, manifestPath, 'TOKEN');
    secrets.values.set(secretId, 'previous-token');
    store.failWrites = true;

    await expect(
      registry.updateMemberConfigs(machine, manifestPath, {
        ENDPOINT: 'https://example.test',
        TOKEN: 'next-token',
      }),
    ).rejects.toThrow('registry write failed');

    expect(secrets.get(secretId)).toBe('previous-token');
    expect(store.load().configs).toEqual([]);
  });

  it('uses stable opaque secret identifiers', () => {
    const id = agentTeamMemberSecretId(machine, manifestPath, 'TOKEN');
    expect(id).toBe(agentTeamMemberSecretId(machine, manifestPath, 'TOKEN'));
    expect(id).toMatch(/^agent-team:member-env:[A-Za-z0-9_-]+$/);
    expect(id).not.toContain(manifestPath);
  });

  it('stores special environment names as own data properties', async () => {
    const result = structuredClone(scanResult);
    result.members[0]?.env.push({
      name: '__proto__',
      description: 'Special field',
      required: false,
      secret: false,
    });
    const registry = new AgentTeamRegistry(
      new InMemoryAgentTeamRegistryStore(),
      { scanAgentTeams: async () => result },
      Date.now,
      undefined,
      new MemorySecretStore(),
    );
    await registry.addRoot(root);
    await registry.updateMemberConfigs(
      machine,
      manifestPath,
      Object.fromEntries([['__proto__', 'safe-value']]),
    );

    const environment = registry.resolveMemberEnvironment(
      machine,
      manifestPath,
    );
    expect(Object.hasOwn(environment, '__proto__')).toBe(true);
    expect(environment['__proto__']).toBe('safe-value');
    expect(Object.getPrototypeOf(environment)).toBe(Object.prototype);
  });
});
