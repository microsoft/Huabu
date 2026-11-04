// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedIdentity } from './service.js';

/**
 * A member's model keys and connected credentials are their own: the secret
 * store and the settings files answer from a personal namespace, and the
 * deployment's environment, which is the operator's, is never theirs.
 */

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV = [
  'HUABU_DATA_DIR',
  'HUABU_SECRET_KEY',
  'TAVILY_API_KEY',
  'VISION_ENDPOINT',
  'VISION_KEY',
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-personal-settings-'));
  for (const key of ENV) saved[key] = process.env[key];
  process.env.HUABU_DATA_DIR = tmp;
  process.env.TAVILY_API_KEY = 'operator-env-key';
  delete process.env.HUABU_SECRET_KEY;
  vi.restoreAllMocks();
  vi.resetModules();
});
afterEach(() => {
  for (const key of ENV)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  rmSync(tmp, { recursive: true, force: true });
});

const person = (principalId: string, owner = false): ResolvedIdentity => ({
  principal: { principalId, kind: 'user' },
  member: true,
  owner,
  access: {
    can: async () => true,
    claim: async () => {},
    workspaces: async () => 'all',
  },
});

describe('personal settings', () => {
  it('isolates pi-ai runtime model state and refuses deployment environment auth for a member', async () => {
    const scope = await import('./personal-settings.js');
    const { getPiModels } = await import('../agent/pi-models.js');
    const { initializeSecretStore } =
      await import('../../security/secret-store.js');
    await initializeSecretStore();
    vi.stubEnv('OPENAI_API_KEY', 'deployment-key');
    try {
      const deployment = getPiModels();
      const carol = scope.openPersonalSettings(() => {
        scope.useCaller(person('carol'));
        return getPiModels();
      });
      const dave = scope.openPersonalSettings(() => {
        scope.useCaller(person('dave'));
        return getPiModels();
      });
      expect(carol).not.toBe(deployment);
      expect(dave).not.toBe(carol);
      expect(
        scope.openPersonalSettings(() => {
          scope.useCaller(person('carol'));
          return getPiModels();
        }),
      ).toBe(carol);
      expect(
        await scope.openPersonalSettings(() => {
          scope.useCaller(person('carol'));
          return getPiModels().getAuth('openai');
        }),
      ).toBeUndefined();
      expect(await deployment.getAuth('openai')).toMatchObject({
        auth: { apiKey: 'deployment-key' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('keeps OCR legacy files, environment credentials and stored records with their owner', async () => {
    process.env.VISION_ENDPOINT =
      'https://operator.cognitiveservices.azure.com';
    process.env.VISION_KEY = 'operator-key';
    writeFileSync(
      join(tmp, 'ink-ocr-config.json'),
      JSON.stringify({
        endpoint: 'https://legacy.cognitiveservices.azure.com',
      }),
    );
    const store = await import('../../security/secret-store.js');
    const scope = await import('./personal-settings.js');
    const ocr = await import('../integrations/ink-ocr-config.js');
    await store.initializeSecretStore();
    const as = <T>(id: string, fn: () => T) =>
      scope.openPersonalSettings(() => {
        scope.useCaller(person(id));
        return fn();
      });
    expect(ocr.resolveInkOcrConfiguration()).toEqual({
      endpoint: 'https://legacy.cognitiveservices.azure.com',
      key: 'operator-key',
    });
    expect(as('carol', ocr.resolveInkOcrConfiguration)).toEqual({
      endpoint: null,
      key: null,
    });
    await as('carol', () =>
      ocr.setInkOcrConfig({
        endpoint: 'https://carol.cognitiveservices.azure.com',
        apiKey: 'carol-key',
      }),
    );
    expect(as('carol', ocr.resolveInkOcrConfiguration)).toEqual({
      endpoint: 'https://carol.cognitiveservices.azure.com',
      key: 'carol-key',
    });
    expect(as('dave', ocr.getInkOcrConfig)).toMatchObject({
      configured: false,
      endpointSource: 'none',
      keySource: 'none',
    });
  });

  it('discovers and invalidates live OpenAI models independently for concurrent members', async () => {
    const store = await import('../../security/secret-store.js');
    const scope = await import('./personal-settings.js');
    const llm = await import('../agent/llm.js');
    await store.initializeSecretStore();
    const as = <T>(id: string, fn: () => T) =>
      scope.openPersonalSettings(() => {
        scope.useCaller(person(id));
        return fn();
      });
    await as('carol', () =>
      llm.setLLMConfig({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'carol-key',
        baseUrl: 'https://carol.example/v1',
      }),
    );
    await as('dave', () =>
      llm.setLLMConfig({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'dave-key',
        baseUrl: 'https://dave.example/v1',
      }),
    );
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const owner = String(input).includes('carol') ? 'carol' : 'dave';
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          `Bearer ${owner}-key`,
        );
        return Response.json({ data: [{ id: `gpt-${owner}` }] });
      },
    );
    vi.spyOn(
      await import('../security/outbound.js'),
      'outboundFetch',
    ).mockImplementation(fetchMock);
    try {
      const [carol, dave] = await Promise.all([
        as('carol', () => llm.getModelsForProviderLive('openai')),
        as('dave', () => llm.getModelsForProviderLive('openai')),
      ]);
      expect(carol.map((m) => m.id)).toEqual(['gpt-carol']);
      expect(dave.map((m) => m.id)).toEqual(['gpt-dave']);
      await as('carol', () =>
        llm.setLLMConfig({
          provider: 'openai',
          baseUrl: 'https://carol.example/v2',
        }),
      );
      await as('dave', () => llm.getModelsForProviderLive('openai'));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await as('carol', () => llm.getModelsForProviderLive('openai'));
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps each member’s credentials apart from the deployment’s and each other’s', async () => {
    const store = await import('../../security/secret-store.js');
    const scope = await import('./personal-settings.js');
    const { SECRET_IDS } = await import('../../security/secret-ids.js');
    await store.initializeSecretStore();
    const as = <T>(identity: ResolvedIdentity | null, fn: () => T) =>
      scope.openPersonalSettings(() => {
        if (identity) scope.useCaller(identity);
        return fn();
      });
    const tavily = SECRET_IDS.tavilyApiKey;

    // The deployment falls back to its environment; a member does not.
    expect(as(null, () => store.getSecret(tavily))).toBe('operator-env-key');
    expect(as(person('carol'), () => store.getSecret(tavily))).toBeNull();

    await as(person('carol'), () => store.setSecret(tavily, 'carol-key'));
    await as(person('dave'), () => store.setSecrets({ [tavily]: 'dave-key' }));
    expect(as(person('carol'), () => store.getSecret(tavily))).toBe(
      'carol-key',
    );
    expect(as(person('dave'), () => store.getSecret(tavily))).toBe('dave-key');
    expect(as(null, () => store.getSecret(tavily))).toBe('operator-env-key');
    // Administrators have personal credentials too.
    expect(as(person('admin', true), () => store.getSecret(tavily))).toBeNull();

    // Settings files go under the member's own directory.
    expect(as(person('carol'), () => scope.settingsFilePath('x.json'))).toMatch(
      new RegExp(`^${tmp}/people/[0-9a-f]{32}/x\\.json$`),
    );
    expect(as(null, () => scope.settingsFilePath('x.json'))).toBe(
      join(tmp, 'x.json'),
    );
  });

  it('never namespaces the deployment’s own credentials', async () => {
    const store = await import('../../security/secret-store.js');
    const scope = await import('./personal-settings.js');
    const { SECRET_IDS } = await import('../../security/secret-ids.js');
    await store.initializeSecretStore();
    await store.setSecret(SECRET_IDS.managedConnectionToken, 'machine');
    expect(
      scope.openPersonalSettings(() => {
        scope.useCaller(person('carol'));
        return store.getSecret(SECRET_IDS.managedConnectionToken);
      }),
    ).toBe('machine');
  });

  it('persists independent Agent defaults for members and administrators', async () => {
    const scope = await import('./personal-settings.js');
    const defaults = await import('../agent/agent-defaults.js');
    defaults.setAgentDefaults({
      profileId: 'legacy-external',
      functionalModel: '',
    });
    for (const owner of [false, true]) {
      for (const id of ['carol', 'dave']) {
        scope.openPersonalSettings(() => {
          scope.useCaller(person(`${id}-${owner}`, owner));
          expect(defaults.getAgentDefaults().profileId).toBe('huabu');
          defaults.setAgentDefaults({
            profileId: `${id}-agent`,
            functionalModel: `${id}-model`,
          });
        });
      }
      for (const id of ['carol', 'dave']) {
        scope.openPersonalSettings(() => {
          scope.useCaller(person(`${id}-${owner}`, owner));
          expect(defaults.getAgentDefaults()).toEqual({
            profileId: `${id}-agent`,
            functionalModel: `${id}-model`,
          });
        });
      }
    }
    expect(defaults.getAgentDefaults().profileId).toBe('legacy-external');
  });
});

it('does not expose Azure deployment names or endpoints from the operator environment', async () => {
  vi.stubEnv('AZURE_OPENAI_API_ENDPOINT', 'https://operator.azure.example');
  vi.stubEnv('AZURE_OPENAI_API_DEPLOYMENT_NAME', 'operator-deployment');
  const scope = await import('./personal-settings.js');
  const store = await import('../../security/secret-store.js');
  const llm = await import('../agent/llm.js');
  await store.initializeSecretStore();
  try {
    await scope.openPersonalSettings(async () => {
      scope.useCaller(person('carol'));
      expect(llm.getModelsForProvider('azure-openai')).toEqual([]);
      await llm.setLLMConfig({
        provider: 'azure-openai',
        model: 'carol-model',
        apiKey: 'carol-key',
      });
      expect(llm.getLLMModel().baseUrl).not.toContain('operator');
      expect(llm.getModelsForProvider('azure-openai').map((m) => m.id)).toEqual(
        ['carol-model'],
      );
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('denies artifact source access before reading or returning its bytes', async () => {
  const scope = await import('./personal-settings.js');
  const { resolveArtifactImageUrl } = await import('../artifact/utils.js');
  await scope.openPersonalSettings(async () => {
    scope.useCaller({
      ...person('carol'),
      access: {
        can: async () => false,
        claim: async () => {},
        workspaces: async () => [],
      },
    });
    await expect(
      resolveArtifactImageUrl('/api/canvas/secret/artifact/a.png', 'mine'),
    ).rejects.toThrow('not readable');
    await expect(resolveArtifactImageUrl('a.png', 'secret')).rejects.toThrow(
      'not readable',
    );
  });
});

it('offers members only provider adapters that can honor the guarded transport', async () => {
  const scope = await import('./personal-settings.js');
  const llm = await import('../agent/llm.js');
  expect(
    llm
      .getAvailableProviders()
      .some((provider) => provider.api === 'bedrock-converse-stream'),
  ).toBe(true);
  scope.openPersonalSettings(() => {
    scope.useCaller(person('carol'));
    const providers = llm.getAvailableProviders();
    expect(providers.some((provider) => provider.id === 'openai')).toBe(true);
    expect(
      providers.some((provider) =>
        [
          'bedrock-converse-stream',
          'google-generative-ai',
          'google-vertex',
        ].includes(provider.api),
      ),
    ).toBe(false);
    expect(llm.getModelsForProvider('amazon-bedrock')).toEqual([]);
  });
});
