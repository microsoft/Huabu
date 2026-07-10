/**
 * Integrations (third-party API keys) — persisted store.
 *
 * Optional third-party credentials the server uses on the user's behalf:
 *   - **Tavily** — `web_search` agent tool.
 *   - **RapidAPI** — YouTube transcript loader (node preprocessing).
 *
 * Electron-managed credentials are encrypted by safeStorage; standalone
 * credentials are persisted to `data/integrations.json` (chmod 600). Both
 * are edited via `/api/integrations`. Environment variables
 * (`TAVILY_API_KEY`, `RAPIDAPI_KEY`) remain fallback sources for headless /
 * Docker deployments — a UI-stored key always wins.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { getDataDir } from '../../data-dir.js';
import {
  getDesktopSecret,
  isDesktopSecretBridgeEnabled,
  setDesktopSecret,
} from '../../security/desktop-secret-bridge.js';
import { SECRET_IDS } from '../../security/secret-ids.js';
import { getLogger } from '../../utils/logger.js';

import type {
  IntegrationsConfig,
  IntegrationsConfigUpdate,
} from '@sediment/shared';

const log = getLogger('integrations');

const CONFIG_FILE = join(getDataDir(), 'integrations.json');

/** On-disk shape of `integrations.json`. All fields optional. */
interface PersistedIntegrations {
  tavilyApiKey?: string;
  rapidApiKey?: string;
}

/**
 * In-memory copy of the parsed store. `integrations.json` is only ever
 * written through {@link saveStore} in this process, so we read the file
 * once and serve every subsequent lookup (`getTavilyApiKey` /
 * `getRapidApiKey`, called on each web-search / YouTube fetch) from here
 * instead of a sync disk read per call. `saveStore` refreshes it.
 */
let cache: PersistedIntegrations | null = null;

function loadStore(): PersistedIntegrations {
  if (cache) return cache;
  try {
    if (!existsSync(CONFIG_FILE)) {
      cache = {};
      return cache;
    }
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const store: PersistedIntegrations = {};
    if (typeof parsed.tavilyApiKey === 'string') {
      store.tavilyApiKey = parsed.tavilyApiKey;
    }
    if (typeof parsed.rapidApiKey === 'string') {
      store.rapidApiKey = parsed.rapidApiKey;
    }
    cache = store;
    return cache;
  } catch (err) {
    log.warn({ err }, 'Failed to read integrations.json — treating as empty');
    cache = {};
    return cache;
  }
}

function saveStore(store: PersistedIntegrations): void {
  const dir = dirname(CONFIG_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2), 'utf-8');
  // Keep the in-memory copy in sync with what we just persisted.
  cache = store;
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Non-critical — best effort on platforms that support it.
  }
}

/**
 * Return the masked read model — booleans only, never the plaintext keys.
 * Reflects what has been saved through the UI (env-var fallbacks are not
 * counted here so the toggle accurately shows what the user stored).
 */
export function getIntegrationsConfig(): IntegrationsConfig {
  if (isDesktopSecretBridgeEnabled()) {
    return {
      hasTavilyKey: Boolean(getDesktopSecret(SECRET_IDS.tavilyApiKey)),
      hasRapidApiKey: Boolean(getDesktopSecret(SECRET_IDS.rapidApiKey)),
    };
  }
  const store = loadStore();
  return {
    hasTavilyKey: Boolean(store.tavilyApiKey),
    hasRapidApiKey: Boolean(store.rapidApiKey),
  };
}

/**
 * Apply an update. Only non-empty strings are written — an omitted or
 * empty field leaves the existing key untouched (so the client never has
 * to echo back a secret it cannot read). Returns the fresh masked model.
 */
export async function setIntegrationsConfig(
  update: IntegrationsConfigUpdate,
): Promise<IntegrationsConfig> {
  if (isDesktopSecretBridgeEnabled()) {
    if (typeof update.tavilyApiKey === 'string' && update.tavilyApiKey !== '') {
      await setDesktopSecret(SECRET_IDS.tavilyApiKey, update.tavilyApiKey);
    }
    if (typeof update.rapidApiKey === 'string' && update.rapidApiKey !== '') {
      await setDesktopSecret(SECRET_IDS.rapidApiKey, update.rapidApiKey);
    }
    return getIntegrationsConfig();
  }
  // Work on a copy so a failed write can't leave the in-memory cache
  // ahead of disk (saveStore commits the copy to the cache on success).
  const store = { ...loadStore() };
  if (typeof update.tavilyApiKey === 'string' && update.tavilyApiKey !== '') {
    store.tavilyApiKey = update.tavilyApiKey;
  }
  if (typeof update.rapidApiKey === 'string' && update.rapidApiKey !== '') {
    store.rapidApiKey = update.rapidApiKey;
  }
  saveStore(store);
  return {
    hasTavilyKey: Boolean(store.tavilyApiKey),
    hasRapidApiKey: Boolean(store.rapidApiKey),
  };
}

/**
 * Resolve the effective Tavily API key: the UI-stored key wins, falling
 * back to `TAVILY_API_KEY` for headless deployments. Returns `undefined`
 * when neither is set.
 */
export function getTavilyApiKey(): string | undefined {
  if (isDesktopSecretBridgeEnabled()) {
    return (
      getDesktopSecret(SECRET_IDS.tavilyApiKey) || process.env.TAVILY_API_KEY
    );
  }
  return loadStore().tavilyApiKey || process.env.TAVILY_API_KEY || undefined;
}

/**
 * Resolve the effective RapidAPI key: the UI-stored key wins, falling
 * back to `RAPIDAPI_KEY` for headless deployments. Returns `undefined`
 * when neither is set.
 */
export function getRapidApiKey(): string | undefined {
  if (isDesktopSecretBridgeEnabled()) {
    return getDesktopSecret(SECRET_IDS.rapidApiKey) || process.env.RAPIDAPI_KEY;
  }
  return loadStore().rapidApiKey || process.env.RAPIDAPI_KEY || undefined;
}
