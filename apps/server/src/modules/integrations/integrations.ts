// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Integrations (third-party API keys) — persisted store.
 *
 * Optional third-party credentials the server uses on the user's behalf:
 *   - **Tavily** — `web_search` agent tool.
 *   - **RapidAPI** — YouTube transcript loader (node preprocessing).
 *
 * Credentials are persisted by the runtime SecretStore and edited via
 * `/api/integrations`. Environment variables
 * (`TAVILY_API_KEY`, `RAPIDAPI_KEY`) remain fallback sources for headless /
 * Docker deployments — a UI-stored key always wins.
 */

import { SECRET_IDS } from '../../security/secret-ids.js';
import {
  getPersistedSecret,
  getSecret,
  setSecrets,
} from '../../security/secret-store.js';

import type {
  IntegrationsConfig,
  IntegrationsConfigUpdate,
} from '@huabu/shared';

/**
 * Return the masked read model — booleans only, never the plaintext keys.
 * Reflects what has been saved through the UI (env-var fallbacks are not
 * counted here so the toggle accurately shows what the user stored).
 */
export function getIntegrationsConfig(): IntegrationsConfig {
  return {
    hasTavilyKey: Boolean(getPersistedSecret(SECRET_IDS.tavilyApiKey)),
    hasRapidApiKey: Boolean(getPersistedSecret(SECRET_IDS.rapidApiKey)),
  };
}

/**
 * Apply an update. Omitted fields preserve their current value, strings set
 * a key, and `null` removes the key stored by Huabu. Returns the fresh masked
 * model.
 */
export async function setIntegrationsConfig(
  update: IntegrationsConfigUpdate,
): Promise<IntegrationsConfig> {
  // Collect all touched keys and write them in one batch. On the
  // encrypted-file backend this is a single atomic file replacement; on the
  // Electron bridge backend it currently degrades to a sequential per-key
  // write, so a mid-batch failure there can still leave an earlier key
  // committed (see ElectronSecretStore.setMany). Batching keeps the call site
  // ready for full atomicity once the bridge gains a batch message.
  const updates: Record<string, string | null> = {};
  if (update.tavilyApiKey !== undefined) {
    updates[SECRET_IDS.tavilyApiKey] = update.tavilyApiKey;
  }
  if (update.rapidApiKey !== undefined) {
    updates[SECRET_IDS.rapidApiKey] = update.rapidApiKey;
  }
  if (Object.keys(updates).length > 0) await setSecrets(updates);
  return getIntegrationsConfig();
}

/**
 * Resolve the effective Tavily API key: the UI-stored key wins, falling
 * back to `TAVILY_API_KEY` for headless deployments. Returns `undefined`
 * when neither is set.
 */
export function getTavilyApiKey(): string | undefined {
  return getSecret(SECRET_IDS.tavilyApiKey) ?? undefined;
}

/**
 * Resolve the effective RapidAPI key: the UI-stored key wins, falling
 * back to `RAPIDAPI_KEY` for headless deployments. Returns `undefined`
 * when neither is set.
 */
export function getRapidApiKey(): string | undefined {
  return getSecret(SECRET_IDS.rapidApiKey) ?? undefined;
}
