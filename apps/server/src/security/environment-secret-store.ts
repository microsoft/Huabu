// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getEnvApiKey } from '@earendil-works/pi-ai/compat';

import { parseLlmProviderApiKeySecretId, SECRET_IDS } from './secret-ids.js';
import { personalSettingsOwner } from '../modules/identity/personal-settings.js';

import type { SecretStore } from './secret-store-types.js';
import type { KnownProvider } from '@earendil-works/pi-ai';

/**
 * Read-only deployment credentials and provider environment. Personal callers
 * never inherit these values or pi-ai's ambient credential-file fallback.
 */
export class EnvironmentSecretStore implements SecretStore {
  readonly kind = 'environment';
  readonly writable = false;

  async initialize(): Promise<void> {}

  /** Deployment-only provider configuration; undefined for a personal caller. */
  getEnvironmentValue(name: string): string | undefined {
    return personalSettingsOwner() ? undefined : process.env[name];
  }

  /**
   * Suppress pi-ai's ambient environment/file auth for personal Models. An
   * absent override keeps its existing operator behavior in local mode.
   */
  getAuthContext() {
    return personalSettingsOwner()
      ? {
          env: async (_name: string) => undefined,
          fileExists: async (_path: string) => false,
        }
      : undefined;
  }

  get(id: string): string | null {
    if (personalSettingsOwner()) return null;
    if (id === SECRET_IDS.tavilyApiKey) {
      return process.env.TAVILY_API_KEY ?? null;
    }
    if (id === SECRET_IDS.hackmdApiKey) {
      return process.env.HMD_API_ACCESS_TOKEN?.trim() || null;
    }
    if (id === SECRET_IDS.rapidApiKey) {
      return process.env.RAPIDAPI_KEY ?? null;
    }
    if (id === SECRET_IDS.inkOcrApiKey) {
      return process.env.VISION_KEY?.trim() || null;
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
