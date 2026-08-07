// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export const SECRET_IDS = {
  imageApiKey: 'llm:image:api-key',
  tavilyApiKey: 'integration:tavily:api-key',
  rapidApiKey: 'integration:rapidapi:api-key',
  copilotOAuth: 'oauth:github-copilot:credentials',
  codexOAuth: 'oauth:openai-codex:credentials',
} as const;

const LLM_PROVIDER_ID_PATTERN = /^[a-z0-9._-]{1,64}$/i;

export function llmProviderApiKeySecretId(provider: string): string {
  if (!LLM_PROVIDER_ID_PATTERN.test(provider)) {
    throw new Error('Invalid LLM provider id');
  }
  return `llm:provider:${provider}:api-key`;
}

const LLM_PROVIDER_SECRET_PATTERN =
  /^llm:provider:([a-z0-9._-]{1,64}):api-key$/i;

export function parseLlmProviderApiKeySecretId(id: string): string | null {
  return LLM_PROVIDER_SECRET_PATTERN.exec(id)?.[1] ?? null;
}

export function isSecretId(id: string): boolean {
  return (
    Object.values(SECRET_IDS).includes(
      id as (typeof SECRET_IDS)[keyof typeof SECRET_IDS],
    ) || parseLlmProviderApiKeySecretId(id) !== null
  );
}
