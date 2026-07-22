import { describe, expect, it } from 'vitest';

import {
  llmConfigUpdateSchema,
  llmUtilityConfigUpdateSchema,
} from '@sediment/shared';

import {
  getAvailableProviders,
  getModelsForProvider,
  isOpenAIChatModelId,
  mergeOpenAIModels,
} from './llm.js';

import type { LLMModelInfo } from '@sediment/shared';

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
