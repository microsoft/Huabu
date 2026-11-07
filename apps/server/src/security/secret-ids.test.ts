// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { EnvironmentSecretStore } from './environment-secret-store.js';
import {
  isSecretId,
  llmProviderApiKeySecretId,
  parseLlmProviderApiKeySecretId,
  SECRET_IDS,
} from './secret-ids.js';
import {
  openPersonalSettings,
  useCaller,
} from '../modules/identity/personal-settings.js';
import { UNRESTRICTED_ACCESS } from '../modules/identity/service.js';

it.each([false, true])(
  'blocks ambient provider credentials/configuration for a personal caller (administrator=%s)',
  async (owner) => {
    vi.stubEnv('OPENAI_API_KEY', 'operator-model-key');
    vi.stubEnv('VISION_KEY', 'operator-ocr-key');
    vi.stubEnv(
      'VISION_ENDPOINT',
      'https://operator.cognitiveservices.azure.com',
    );
    try {
      const environment = new EnvironmentSecretStore();
      const modelKey = llmProviderApiKeySecretId('openai');
      expect(environment.get(modelKey)).toBe('operator-model-key');
      expect(environment.getAuthContext()).toBeUndefined();
      await openPersonalSettings(async () => {
        useCaller({
          principal: { principalId: 'personal-user', kind: 'user' },
          member: true,
          owner,
          access: UNRESTRICTED_ACCESS,
        });
        expect(environment.get(modelKey)).toBeNull();
        expect(environment.get(SECRET_IDS.inkOcrApiKey)).toBeNull();
        expect(
          environment.getEnvironmentValue('VISION_ENDPOINT'),
        ).toBeUndefined();
        const context = environment.getAuthContext();
        expect(context).toBeDefined();
        expect(await context?.env('OPENAI_API_KEY')).toBeUndefined();
        expect(await context?.fileExists('/operator/credentials')).toBe(false);
      });
      expect(environment.get(modelKey)).toBe('operator-model-key');
      expect(environment.getEnvironmentValue('VISION_ENDPOINT')).toContain(
        'operator.',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('recognizes the dedicated OCR record id without mapping it to VISION_KEY', () => {
  expect(SECRET_IDS.inkOcrConfig).toBe('integration:azure-vision:config');
  expect(isSecretId(SECRET_IDS.inkOcrConfig)).toBe(true);
  expect(isSecretId(SECRET_IDS.inkOcrApiKey)).toBe(true);
  vi.stubEnv('VISION_KEY', 'fake-environment-key');
  try {
    const environment = new EnvironmentSecretStore();
    expect(environment.get(SECRET_IDS.inkOcrConfig)).toBeNull();
    expect(environment.get(SECRET_IDS.inkOcrApiKey)).toBe(
      'fake-environment-key',
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('LLM provider secret ids', () => {
  it('generates ids for valid provider names up to 64 characters', () => {
    expect(llmProviderApiKeySecretId('azure-openai')).toBe(
      'llm:provider:azure-openai:api-key',
    );

    const longestProvider = 'a'.repeat(64);
    expect(llmProviderApiKeySecretId(longestProvider)).toBe(
      `llm:provider:${longestProvider}:api-key`,
    );
  });

  it.each(['', 'a'.repeat(65), 'provider:name', 'provider name'])(
    'rejects invalid provider id %j',
    (provider) => {
      expect(() => llmProviderApiKeySecretId(provider)).toThrow(
        'Invalid LLM provider id',
      );
    },
  );

  it('parses only provider ids accepted by the generator', () => {
    expect(
      parseLlmProviderApiKeySecretId(`llm:provider:${'a'.repeat(64)}:api-key`),
    ).toBe('a'.repeat(64));
    expect(
      parseLlmProviderApiKeySecretId(`llm:provider:${'a'.repeat(65)}:api-key`),
    ).toBeNull();
  });
});
