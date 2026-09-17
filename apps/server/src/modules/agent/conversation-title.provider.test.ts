// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ThreadRecord } from '@agenetes/agenetes';
import type * as PiCompat from '@earendil-works/pi-ai/compat';

const complete = vi.hoisted(() => vi.fn());
vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => ({
  ...(await importOriginal<typeof PiCompat>()),
  complete,
  getEnvApiKey: () => undefined,
}));
vi.mock('../../security/secret-store.js', () => ({
  getSecret: () => 'test-only-key',
  getPersistedSecret: () => null,
  setSecret: vi.fn(),
}));

let tmp: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
  complete.mockReset();
});

describe('conversation naming through canonical ProviderManager routing', () => {
  it('returns undefined without configuration, retains ACP, then upgrades through inherited global Chat and explicit utility models', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'huabu-title-provider-'));
    vi.stubEnv('HUABU_DATA_DIR', tmp);
    vi.stubEnv('AZURE_OPENAI_API_KEY', '');
    vi.stubEnv('AZURE_OPENAI_API_ENDPOINT', '');
    vi.stubEnv('AZURE_OPENAI_API_DEPLOYMENT_NAME', '');
    vi.resetModules();
    const { ProviderManager } =
      await import('../preprocessing/provider-manager.js');
    const { setLLMConfig, setUtilityConfig } = await import('./llm.js');
    const { ConversationTitleService } =
      await import('./conversation-title.service.js');
    const provider = new ProviderManager();
    let record: ThreadRecord = {
      driverSchemaVersion: 1,
      spec: {
        kind: 'test',
        workloadType: 'Deployment',
        threadId: 'thread-a',
        namespace: { name: 'canvas-a' },
        spec: {},
      },
      state: {
        driverState: {},
        metadata: { sessionInfo: { title: 'ACP fallback', updatedAt: null } },
      },
    };
    const generate = vi.fn(
      async (prompt: string) =>
        (
          await provider.generateContentMeta(prompt, {
            needLabel: true,
            needSummary: false,
            needKeywords: false,
          })
        )?.label,
    );
    const onError = vi.fn();
    const service = new ConversationTitleService({
      readRecord: () => record,
      updateHostMetadata: (_canvas, _thread, patch) => {
        record = {
          ...record,
          hostMetadata: { ...record.hostMetadata, ...patch },
        };
      },
      firstPrompt: () => 'Original first prompt',
      generate,
      notifications: async function* () {},
      onError,
    });
    await service.initialize('canvas-a', 'thread-a', 'Later prompt');
    expect(generate).toHaveResolvedWith(undefined);
    expect(complete).not.toHaveBeenCalled();
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'ACP fallback',
      source: 'acp',
    });

    await setLLMConfig({
      provider: 'azure-openai',
      model: 'global-chat',
      baseUrl: 'https://example.invalid',
    });
    await setUtilityConfig({ provider: '' });
    complete.mockResolvedValue({
      content: [{ type: 'text', text: '{"label":"Inherited global title"}' }],
    });
    await service.initialize('canvas-a', 'thread-a', 'Another later prompt');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toMatchObject({
      id: 'global-chat',
      provider: 'azure-openai',
    });
    expect(JSON.stringify(complete.mock.calls[0][1])).toContain(
      'Original first prompt',
    );
    expect(JSON.stringify(complete.mock.calls[0][1])).not.toContain(
      'Another later prompt',
    );
    expect(await service.get('canvas-a', 'thread-a')).toEqual({
      title: 'Inherited global title',
      source: 'generated',
    });
    expect(record.state.metadata?.sessionInfo?.title).toBe('ACP fallback');

    await setUtilityConfig({
      provider: 'azure-openai',
      model: 'explicit-utility',
      baseUrl: 'https://example.invalid',
    });
    await provider.generateContentMeta('Another first prompt', {
      needLabel: true,
    });
    expect(complete.mock.calls[1][0]).toMatchObject({
      id: 'explicit-utility',
      provider: 'azure-openai',
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
