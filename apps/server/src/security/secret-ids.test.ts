// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  llmProviderApiKeySecretId,
  parseLlmProviderApiKeySecretId,
} from './secret-ids.js';

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
