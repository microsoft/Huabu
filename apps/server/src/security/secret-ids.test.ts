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
