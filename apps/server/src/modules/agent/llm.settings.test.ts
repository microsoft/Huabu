// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  llmConfigUpdateSchema,
  llmUtilityConfigUpdateSchema,
} from '@huabu/shared';

import {
  getAvailableProviders,
  getModelsForProvider,
  isOpenAIChatModelId,
  mergeOpenAIModels,
  pickCheapestEligibleModel,
  pickCheapestModel,
} from './llm.js';

import type { Api, Model } from '@earendil-works/pi-ai';
import type { LLMModelInfo } from '@huabu/shared';

describe('LLM provider catalog', () => {
  it('describes each provider base URL default and override capability', () => {
    const providers = new Map(
      getAvailableProviders().map((provider) => [provider.id, provider]),
    );

    expect(providers.get('openai')?.baseUrl).toEqual({
      default: 'https://api.openai.com/v1',
      overridable: true,
    });
    expect(providers.get('anthropic')?.baseUrl).toEqual({
      default: 'https://api.anthropic.com',
      overridable: true,
    });
    expect(providers.get('azure-openai')?.baseUrl).toEqual({
      overridable: true,
    });
    expect(providers.get('github-copilot')?.baseUrl).toMatchObject({
      default: expect.any(String),
      overridable: false,
    });
  });

  it('includes the current GPT-5.6 family for OpenAI Codex', () => {
    const models = getModelsForProvider('openai-codex');
    const ids = models.map((model) => model.id);

    expect(ids).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(models.find((model) => model.id === 'gpt-5.6-sol')).toMatchObject({
      name: 'GPT-5.6 Sol',
      provider: 'openai-codex',
      reasoning: true,
      input: ['text', 'image'],
    });
  });

  it('surfaces cost and context window for built-in models', () => {
    const models = getModelsForProvider('openai');
    expect(models.length).toBeGreaterThan(0);

    // At least one real (non-synthesized) model carries pricing +
    // context-window metadata from pi-ai's registry.
    const priced = models.find((m) => m.cost && m.cost.input > 0);
    expect(priced).toBeDefined();
    expect(priced!.cost).toEqual({
      input: expect.any(Number),
      output: expect.any(Number),
    });
    expect(typeof priced!.contextWindow).toBe('number');
    expect(priced!.contextWindow).toBeGreaterThan(0);
  });

  it('surfaces reasoning-effort and service-tier capability for built-in models', () => {
    const models = getModelsForProvider('openai');

    // Reasoning-capable models expose their supported effort levels; the
    // list never contains the internal `off` sentinel.
    const withEfforts = models.filter(
      (m) => (m.reasoningEfforts?.length ?? 0) > 0,
    );
    expect(withEfforts.length).toBeGreaterThan(0);
    for (const m of withEfforts) {
      expect(m.reasoningEfforts).not.toContain('off');
    }

    // OpenAI-responses models advertise the service-tier knob; every value
    // comes from the fixed tier list.
    const withTiers = models.filter((m) => (m.serviceTiers?.length ?? 0) > 0);
    expect(withTiers.length).toBeGreaterThan(0);
    for (const m of withTiers) {
      for (const tier of m.serviceTiers!) {
        expect(['auto', 'flex', 'priority']).toContain(tier);
      }
    }
  });
});

describe('OpenAI live model discovery', () => {
  it('excludes non-chat OpenAI model ids', () => {
    expect(isOpenAIChatModelId('gpt-5.6')).toBe(true);
    expect(isOpenAIChatModelId('gpt-5.6-sol')).toBe(true);
    expect(isOpenAIChatModelId('text-embedding-3-large')).toBe(false);
    expect(isOpenAIChatModelId('dall-e-3')).toBe(false);
    expect(isOpenAIChatModelId('gpt-4o-mini-tts')).toBe(false);
    expect(isOpenAIChatModelId('whisper-1')).toBe(false);
    expect(isOpenAIChatModelId('gpt-realtime-2')).toBe(false);
    expect(isOpenAIChatModelId('omni-moderation-latest')).toBe(false);
    expect(isOpenAIChatModelId('gpt-image-2')).toBe(false);
  });

  it('reuses static metadata for known ids and defaults unknown ids', () => {
    const staticModels: LLMModelInfo[] = [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        provider: 'openai',
        reasoning: true,
        input: ['text', 'image'],
      },
    ];

    const merged = mergeOpenAIModels(
      ['gpt-5.6', 'gpt-5.5', 'text-embedding-3-large', 'gpt-5.6'],
      staticModels,
    );

    // Live ordering preserved, non-chat filtered, duplicates dropped.
    expect(merged.map((m) => m.id)).toEqual(['gpt-5.6', 'gpt-5.5']);

    // Known id reuses curated static metadata (reasoning: true).
    expect(merged.find((m) => m.id === 'gpt-5.5')).toEqual(staticModels[0]);

    // Unknown id defaults to multimodal input, no reasoning flag.
    expect(merged.find((m) => m.id === 'gpt-5.6')).toMatchObject({
      id: 'gpt-5.6',
      name: 'gpt-5.6',
      provider: 'openai',
      reasoning: false,
      input: ['text', 'image'],
    });
  });

  it('falls back to the static list when no live id is selectable', () => {
    const staticModels: LLMModelInfo[] = [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        provider: 'openai',
        reasoning: true,
        input: ['text', 'image'],
      },
    ];

    expect(mergeOpenAIModels(['text-embedding-3-large'], staticModels)).toBe(
      staticModels,
    );
  });
});

describe('utility tier cheapest-model selection', () => {
  const model = (id: string, input: number, output: number) =>
    ({
      id,
      name: id,
      cost: { input, output, cacheRead: 0, cacheWrite: 0 },
    }) as unknown as Model<Api>;

  it('picks the lowest combined input + output price', () => {
    const cheapest = pickCheapestModel([
      model('flagship', 5, 15),
      model('mid', 1, 3),
      model('mini', 0.15, 0.6),
    ]);
    expect(cheapest?.id).toBe('mini');
  });

  it('skips zero/unknown-priced entries so they never win', () => {
    const cheapest = pickCheapestModel([
      model('synth', 0, 0),
      model('real', 2, 6),
    ]);
    expect(cheapest?.id).toBe('real');
  });

  it('returns null when no model has a known positive price', () => {
    expect(pickCheapestModel([model('a', 0, 0), model('b', 0, 5)])).toBeNull();
  });

  it('only considers models in the account entitlement', () => {
    const cheapest = pickCheapestEligibleModel(
      [model('unavailable-mini', 0.1, 0.2), model('available-mini', 0.2, 0.4)],
      new Set(['available-mini']),
    );

    expect(cheapest?.id).toBe('available-mini');
  });

  it('returns null when no priced catalog model is eligible', () => {
    expect(
      pickCheapestEligibleModel(
        [model('catalog-only', 0.1, 0.2)],
        new Set(['account-only']),
      ),
    ).toBeNull();
  });
});

describe('LLM config patch schemas', () => {
  it('accepts chat and utility updates without a model', () => {
    expect(
      llmConfigUpdateSchema.parse({
        provider: 'openai',
        baseUrl: 'https://proxy.example/v1',
      }),
    ).toEqual({
      provider: 'openai',
      baseUrl: 'https://proxy.example/v1',
    });
    expect(
      llmUtilityConfigUpdateSchema.parse({
        provider: 'anthropic',
        baseUrl: 'https://proxy.example/anthropic',
      }),
    ).toEqual({
      provider: 'anthropic',
      baseUrl: 'https://proxy.example/anthropic',
    });
  });
});

/**
 * Executable backlog for `setLLMConfig`'s cross-subsystem write compensation.
 *
 * The api key lives in the SecretStore while provider/model live in a plain
 * config file, so the two cannot be written atomically. `setLLMConfig` rolls
 * the secret back when the config write fails, and logs + throws a
 * partial-commit error when the rollback itself fails.
 *
 * These paths are untested because `savePersistedStore` (writeFileSync) and the
 * module-level pino logger (also fs-backed) make a global `node:fs` mock break
 * the logger. Testing cleanly needs `savePersistedStore` / the config read
 * extracted into an injectable seam first.
 *
 * See docs/proposals/credential-storage-hardening-followups.md (item 2).
 */
describe('setLLMConfig cross-file write compensation', () => {
  it.todo('restores the previous api key when the config file write fails');
  it.todo(
    'throws a partial-commit error and logs when config write AND rollback both fail',
  );
});
