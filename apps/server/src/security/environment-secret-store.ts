// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getEnvApiKey } from '@earendil-works/pi-ai/compat';

import { parseLlmProviderApiKeySecretId, SECRET_IDS } from './secret-ids.js';

import type { SecretStore } from './secret-store-types.js';
import type { KnownProvider } from '@earendil-works/pi-ai';

/** Read-only fallback over process.env (including values loaded from .env). */
export class EnvironmentSecretStore implements SecretStore {
  readonly kind = 'environment';
  readonly writable = false;

  async initialize(): Promise<void> {}

  get(id: string): string | null {
    if (id === SECRET_IDS.tavilyApiKey) {
      return process.env.TAVILY_API_KEY ?? null;
    }
    if (id === SECRET_IDS.rapidApiKey) {
      return process.env.RAPIDAPI_KEY ?? null;
    }
    if (id === SECRET_IDS.imageApiKey) {
      return process.env.AZURE_OPENAI_API_KEY ?? null;
    }
    if (id === SECRET_IDS.copilotOAuth) return null;

    const provider = parseLlmProviderApiKeySecretId(id);
    if (!provider) return null;
    const piProvider =
      provider === 'azure-openai' ? 'azure-openai-responses' : provider;
    return getEnvApiKey(piProvider as KnownProvider) ?? null;
  }

  async set(_id: string, _value: string | null): Promise<void> {
    throw new Error(
      'Credential storage is read-only. Set HUABU_SECRET_KEY to enable encrypted settings persistence.',
    );
  }

  async setMany(_updates: Record<string, string | null>): Promise<void> {
    throw new Error(
      'Credential storage is read-only. Set HUABU_SECRET_KEY to enable encrypted settings persistence.',
    );
  }
}
