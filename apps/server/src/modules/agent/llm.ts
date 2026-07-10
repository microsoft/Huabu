/**
 * LLM Configuration — pi-ai based, multi-provider
 *
 * Supports dynamic provider/model switching at runtime.
 * Configuration is persisted to data/llm-config.json and can be
 * changed via the /api/llm routes.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  stream as piStream,
  complete as piComplete,
  getEnvApiKey,
  getModel,
  getModels,
  getProviders,
} from '@earendil-works/pi-ai';

import {
  DEFAULT_AZURE_IMAGE_API_VERSION,
  DEFAULT_IMAGE_MODEL_FAMILY,
  isImageModelFamily,
  MODEL_ROLES,
} from '@sediment/shared';

import {
  getCopilotApiKey,
  verifyOAuthCredentials,
  applyCopilotModelOverrides,
  getCopilotStaticHeaders,
  fetchEntitledCopilotModels,
} from './oauth.js';
import { getDataDir } from '../../data-dir.js';
import { getLogger } from '../../utils/logger.js';

import type {
  Api,
  Context,
  KnownProvider,
  Model,
  ProviderStreamOptions,
} from '@earendil-works/pi-ai';
import type {
  ImageModelFamily,
  LLMConfig,
  LLMConfigUpdate,
  LLMImageConfig,
  LLMImageConfigUpdate,
  LLMModelInfo,
  LLMProviderInfo,
  LLMUtilityConfig,
  LLMUtilityConfigUpdate,
  ModelRole,
} from '@sediment/shared';

const log = getLogger('llm');

// ==================== Provider Catalog ====================

/** Provider-specific metadata not available from pi-ai's registry. */
const PROVIDER_OVERRIDES: Record<string, Partial<LLMProviderInfo>> = {
  'azure-openai-responses': {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    builtIn: false,
  },
  'github-copilot': {
    authType: 'oauth',
  },
};

/** Display-friendly names for providers whose pi-ai ID is cryptic. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'azure-openai-responses': 'Azure OpenAI',
  google: 'Google Gemini',
  'google-vertex': 'Google Vertex AI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  xai: 'xAI',
  mistral: 'Mistral',
  'amazon-bedrock': 'Amazon Bedrock',
  'github-copilot': 'GitHub Copilot',
};

/**
 * Build provider catalog dynamically from pi-ai's registry.
 * Falls back to a reasonable default for unknown providers.
 */
function buildProviderCatalog(): LLMProviderInfo[] {
  const knownProviders = getProviders();
  const catalog: LLMProviderInfo[] = knownProviders.map((id) => {
    const overrides = PROVIDER_OVERRIDES[id];
    const models = getModels(id);
    const api = models[0]?.api ?? 'openai-completions';
    const baseUrl = models[0]?.baseUrl;
    return {
      id: overrides?.id ?? id,
      name: PROVIDER_DISPLAY_NAMES[id] ?? id,
      api,
      builtIn: overrides?.builtIn ?? true,
      ...(baseUrl ? { defaultBaseUrl: baseUrl } : {}),
      ...(overrides?.authType ? { authType: overrides.authType } : {}),
    };
  });

  // Deduplicate by id (e.g. azure-openai-responses -> azure-openai)
  const seen = new Set<string>();
  return catalog.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

let _providerCatalog: LLMProviderInfo[] | null = null;
function getProviderCatalog(): LLMProviderInfo[] {
  if (!_providerCatalog) _providerCatalog = buildProviderCatalog();
  return _providerCatalog;
}

// ==================== Persisted Config ====================

/** Resolve a data file path relative to the project root. */
function getDataFilePath(filename: string): string {
  return join(getDataDir(), filename);
}

const CONFIG_FILE = getDataFilePath('llm-config.json');

/**
 * Effective active configuration assembled from the persisted store —
 * the shape consumed by `buildModel` / `resolveApiKey` etc.
 */
interface PersistedConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  apiVersion?: string;
}

/**
 * Per-provider persisted fields. Stored in a map keyed by provider id so
 * switching providers doesn't wipe the previous provider's credentials
 * (e.g. switching from Azure → OpenAI → Azure restores the Azure
 * endpoint / deployment / key / api version exactly as you left them).
 */
interface ProviderPersisted {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  apiVersion?: string;
}

/**
 * Persisted image-generation provider entry. Lives at the top level
 * of {@link PersistedStore} — not inside `providers` — because chat
 * and image are now fully independent (different provider /
 * endpoint / key). Today only `azure-openai` is supported but the
 * shape is provider-agnostic so future image providers don't need a
 * schema migration.
 */
interface ImageConfigPersisted {
  provider?: string;
  baseUrl?: string;
  model?: string;
  /**
   * Model family this deployment belongs to (see
   * `@sediment/shared/llm/image-capabilities`). When absent on a
   * legacy entry we default to `gpt-image-2` at read time — that
   * matches the only image model Sediment shipped before this field
   * was introduced.
   */
  modelFamily?: ImageModelFamily;
  apiVersion?: string;
  apiKey?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
}

/**
 * On-disk shape of `llm-config.json`. The optional top-level `active`
 * tracks which provider is currently selected.
 */
interface PersistedStore {
  active?: string;
  providers: Record<string, ProviderPersisted>;
  /**
   * Separate image-provider config, independent of `active` and
   * `providers`. See {@link ImageConfigPersisted}.
   */
  imageConfig?: ImageConfigPersisted;
  /**
   * Utility-tier model config (labeling / summaries / keywords). Lives at
   * the top level, independent of `active`. Absent (or `provider` unset)
   * means "follow the chat model". Note: **no `apiKey` here** — the
   * utility model's credential is resolved from the shared `providers` map
   * keyed by `provider`, so a key entered in the utility panel is stored
   * once and reused whether the same provider drives chat or utility.
   */
  utilityConfig?: UtilityConfigPersisted;
}

/**
 * Persisted utility-tier config. Chat-shaped minus the key (see
 * {@link PersistedStore.utilityConfig}).
 */
interface UtilityConfigPersisted {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiVersion?: string;
}

/**
 * Load + migrate the persisted store. Two migrations applied lazily:
 *  1. **Legacy single-config shape** `{ provider, model, apiKey,
 *     baseUrl, apiVersion, imageModel?, imageQuality? }` \u2192 the new
 *     `{ active, providers: { [id]: \u2026 } }` map shape, with image
 *     fields lifted into the new top-level `imageConfig`.
 *  2. **Pre-split image fields** under `providers['azure-openai']`
 *     (an in-flight intermediate format from earlier today) \u2192
 *     lifted into top-level `imageConfig` so chat and image become
 *     independent. The chat entry keeps its endpoint/key/apiVersion;
 *     the legacy `imageModel` / `imageQuality` keys are dropped.
 *
 * The migrated shape is only written back on the next `setLLMConfig`\n * / `setImageConfig` call \u2014 we never write on a pure load.
 */
function loadPersistedStore(): PersistedStore {
  try {
    if (!existsSync(CONFIG_FILE)) return { providers: {} };
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Legacy shape — single active provider, fields at top level.
    if (
      typeof parsed.provider === 'string' &&
      typeof parsed.providers !== 'object'
    ) {
      const provider = parsed.provider;
      const entry: ProviderPersisted = {};
      if (typeof parsed.model === 'string') entry.model = parsed.model;
      if (typeof parsed.apiKey === 'string') entry.apiKey = parsed.apiKey;
      if (typeof parsed.baseUrl === 'string') entry.baseUrl = parsed.baseUrl;
      if (typeof parsed.apiVersion === 'string') {
        entry.apiVersion = parsed.apiVersion;
      }
      const store: PersistedStore = {
        active: provider,
        providers: { [provider]: entry },
      };
      // Hoist legacy top-level image fields into the new
      // `imageConfig` (only meaningful when the legacy provider was
      // Azure, but we mirror whatever was on disk so nothing is lost).
      const legacyImageConfig = extractLegacyImageConfig(parsed, entry);
      if (legacyImageConfig) store.imageConfig = legacyImageConfig;
      return store;
    }

    const providers =
      (parsed.providers as Record<string, ProviderPersisted> | undefined) ?? {};
    const store: PersistedStore = { providers };
    if (typeof parsed.active === 'string') store.active = parsed.active;
    const existingImageConfig = parsed.imageConfig as
      | ImageConfigPersisted
      | undefined;
    if (existingImageConfig && typeof existingImageConfig === 'object') {
      store.imageConfig = existingImageConfig;
    }
    const existingUtilityConfig = parsed.utilityConfig as
      | UtilityConfigPersisted
      | undefined;
    if (existingUtilityConfig && typeof existingUtilityConfig === 'object') {
      store.utilityConfig = existingUtilityConfig;
    }
    // Migrate pre-split shape: image fields nested under the Azure
    // chat entry. Only seed `imageConfig` when it isn't already set,
    // so a later explicit image-config save wins.
    const azureEntry = providers['azure-openai'] as
      | (ProviderPersisted & {
          imageModel?: string;
          imageQuality?: 'low' | 'medium' | 'high' | 'auto';
        })
      | undefined;
    if (
      !store.imageConfig &&
      azureEntry &&
      (azureEntry.imageModel || azureEntry.imageQuality)
    ) {
      const migrated: ImageConfigPersisted = { provider: 'azure-openai' };
      if (azureEntry.baseUrl) migrated.baseUrl = azureEntry.baseUrl;
      if (azureEntry.apiVersion) migrated.apiVersion = azureEntry.apiVersion;
      if (azureEntry.apiKey) migrated.apiKey = azureEntry.apiKey;
      if (azureEntry.imageModel) migrated.model = azureEntry.imageModel;
      if (azureEntry.imageQuality) migrated.quality = azureEntry.imageQuality;
      store.imageConfig = migrated;
    }
    // Strip the in-memory legacy keys so they don't leak back into a
    // re-serialised PersistedStore on the next save.
    if (azureEntry) {
      delete (azureEntry as { imageModel?: unknown }).imageModel;
      delete (azureEntry as { imageQuality?: unknown }).imageQuality;
    }
    return store;
  } catch {
    // Corrupted or missing file — fall through
    return { providers: {} };
  }
}

/**
 * Build an {@link ImageConfigPersisted} from a legacy top-level
 * config blob, falling back to the migrated chat entry's
 * endpoint / apiVersion / apiKey when the legacy file already has
 * an `imageModel` / `imageQuality` but no dedicated image
 * credentials. Returns `null` when there is nothing image-related
 * to migrate.
 */
function extractLegacyImageConfig(
  parsed: Record<string, unknown>,
  chatEntry: ProviderPersisted,
): ImageConfigPersisted | null {
  const imageModel =
    typeof parsed.imageModel === 'string' ? parsed.imageModel : undefined;
  const imageQuality =
    parsed.imageQuality === 'low' ||
    parsed.imageQuality === 'medium' ||
    parsed.imageQuality === 'high' ||
    parsed.imageQuality === 'auto'
      ? parsed.imageQuality
      : undefined;
  if (!imageModel && !imageQuality) return null;
  const migrated: ImageConfigPersisted = { provider: 'azure-openai' };
  if (chatEntry.baseUrl) migrated.baseUrl = chatEntry.baseUrl;
  if (chatEntry.apiVersion) migrated.apiVersion = chatEntry.apiVersion;
  if (chatEntry.apiKey) migrated.apiKey = chatEntry.apiKey;
  if (imageModel) migrated.model = imageModel;
  if (imageQuality) migrated.quality = imageQuality;
  return migrated;
}

function savePersistedStore(store: PersistedStore): void {
  const dir = dirname(CONFIG_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2), 'utf-8');
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Non-critical — best effort on platforms that support it
  }
}

/** Project a persisted store + provider id down to the effective `PersistedConfig`. */
function buildPersistedConfig(
  store: PersistedStore,
  providerId: string,
): PersistedConfig | null {
  const entry = store.providers[providerId];
  if (!entry) return null;
  return {
    provider: providerId,
    model: entry.model ?? '',
    ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.apiVersion ? { apiVersion: entry.apiVersion } : {}),
  };
}

/** Active persisted config (or `null` if no provider has ever been configured). */
function loadPersistedConfig(): PersistedConfig | null {
  const store = loadPersistedStore();
  if (!store.active) return null;
  return buildPersistedConfig(store, store.active);
}

// ==================== Runtime State ====================

let cachedModel: Model<Api> | null = null;
let cachedApiKey: string | null = null;
let activeConfig: PersistedConfig | null = null;

/**
 * Cached utility-tier model. Built from `store.utilityConfig` and
 * invalidated whenever {@link setUtilityConfig} writes. When utility is
 * following the chat model (no utility config), the resolver returns the
 * chat model directly and this stays null.
 */
let cachedUtilityModel: Model<Api> | null = null;

/** Resolve the API key for a provider from memory, persisted config, or env vars. */
function resolveApiKey(
  providerId: string,
  explicitKey?: string,
): string | null {
  if (explicitKey) return explicitKey;

  // Prefer in-memory config (avoids redundant disk reads)
  const cfg = activeConfig ?? loadPersistedConfig();
  if (cfg?.provider === providerId && cfg.apiKey) {
    return cfg.apiKey;
  }

  // Any provider's stored key — the utility tier may target a provider
  // that is not the active chat provider, and keys are stored per-provider.
  const stored = loadPersistedStore().providers[providerId]?.apiKey;
  if (stored) return stored;

  // Fall back to environment variables via pi-ai
  // pi-ai uses 'azure-openai-responses' instead of our 'azure-openai'
  const piProviderId =
    providerId === 'azure-openai' ? 'azure-openai-responses' : providerId;
  return getEnvApiKey(piProviderId as KnownProvider) ?? null;
}

/**
 * Resolve the API key for OAuth providers (async — may need token refresh).
 * Falls back to resolveApiKey for non-OAuth providers.
 */
async function resolveApiKeyAsync(
  providerId: string,
  explicitKey?: string,
): Promise<string | null> {
  // OAuth providers
  if (providerId === 'github-copilot') {
    return getCopilotApiKey();
  }
  return resolveApiKey(providerId, explicitKey);
}

/** Build a Model object for the active configuration. */
function buildModel(cfg: PersistedConfig): Model<Api> {
  const providerInfo = getProviderCatalog().find((p) => p.id === cfg.provider);

  // Try to get from pi-ai built-in registry first
  if (providerInfo?.builtIn) {
    try {
      const builtIn = getModel(
        cfg.provider as KnownProvider,
        cfg.model as never,
      );
      if (builtIn) {
        let model = builtIn as Model<Api>;
        if (cfg.baseUrl) {
          model = { ...model, baseUrl: cfg.baseUrl };
        }
        // For Copilot, apply pi-ai's model overrides (baseUrl from token, headers)
        if (cfg.provider === 'github-copilot') {
          const [modified] = applyCopilotModelOverrides([model]);
          if (modified) model = modified;
        }
        return model;
      }
    } catch {
      // Model not found in registry — build manually
    }
  }

  // Manual model construction (Azure, custom endpoints, etc.)
  //
  // For github-copilot this path is hit by models newer than the bundled
  // pi-ai registry. We deliberately ignore the provider's catalog `api`
  // (which is derived from the first registry entry and happens to be
  // `anthropic-messages`) and use the OpenAI-compatible `/chat/completions`
  // endpoint, which Copilot's gateway accepts for every chat model.
  const api =
    cfg.provider === 'github-copilot'
      ? 'openai-completions'
      : (providerInfo?.api ?? 'openai-completions');
  let baseUrl = cfg.baseUrl ?? providerInfo?.defaultBaseUrl ?? '';

  // Azure: fall back to legacy env var endpoint when no persisted baseUrl.
  // pi-ai's `normalizeAzureBaseUrl` will append `/openai/v1` as needed, so
  // we deliberately pass the raw endpoint without our own `/openai` suffix.
  if (cfg.provider === 'azure-openai' && !cfg.baseUrl) {
    const endpoint = process.env.AZURE_OPENAI_API_ENDPOINT;
    if (endpoint) {
      baseUrl = endpoint.replace(/\/+$/, '');
    }
  }

  let model: Model<Api> = {
    id: cfg.model,
    name: cfg.model,
    api,
    provider: cfg.provider,
    baseUrl,
    reasoning: false,
    input: ['text', 'image'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  } as Model<Api>;

  // For Copilot, apply pi-ai's model overrides (baseUrl from token).
  //
  // `modifyModels` only rewrites `baseUrl`, so we must seed the required
  // Copilot client headers (`Editor-Version`, `Copilot-Integration-Id`, …)
  // ourselves — otherwise newer ids built on this manual path are rejected
  // with `400 missing Editor-Version header for IDE auth`.
  if (cfg.provider === 'github-copilot') {
    model = {
      ...model,
      headers: getCopilotStaticHeaders(),
    } as Model<Api>;
    const [modified] = applyCopilotModelOverrides([model]);
    if (modified) model = modified;
  }

  return model;
}

/** Initialize the active configuration from persisted config or env vars. */
function ensureConfig(): PersistedConfig {
  if (activeConfig) return activeConfig;

  // Try persisted config
  const persisted = loadPersistedConfig();
  if (persisted) {
    activeConfig = persisted;
    return activeConfig;
  }

  // Fall back to legacy Azure OpenAI env vars
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_API_ENDPOINT;
  const azureDeployment = process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;

  if (azureKey && azureEndpoint && azureDeployment) {
    activeConfig = {
      provider: 'azure-openai',
      model: azureDeployment,
    };
    return activeConfig;
  }

  // Try other providers from env vars
  for (const p of getProviderCatalog()) {
    if (p.builtIn && getEnvApiKey(p.id as KnownProvider)) {
      const models = getModelsForProvider(p.id);
      if (models.length > 0) {
        activeConfig = { provider: p.id, model: models[0].id };
        return activeConfig;
      }
    }
  }

  throw new Error(
    'No LLM provider configured. Set API keys in .env or configure via Settings.',
  );
}

// ==================== Public API ====================

/**
 * Get the list of available providers.
 */
export function getAvailableProviders(): LLMProviderInfo[] {
  return getProviderCatalog();
}

/**
 * Get available models for a given provider.
 */
export function getModelsForProvider(providerId: string): LLMModelInfo[] {
  const providerInfo = getProviderCatalog().find((p) => p.id === providerId);
  if (!providerInfo) return [];

  // Built-in providers: get from pi-ai registry
  if (providerInfo.builtIn) {
    try {
      const models = getModels(providerId as KnownProvider);
      return models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        provider: providerId,
        reasoning: m.reasoning,
        input: m.input as ('text' | 'image')[],
      }));
    } catch {
      return [];
    }
  }

  // Azure: list the configured deployment as the only model
  if (providerId === 'azure-openai') {
    const deployment = process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;
    if (deployment) {
      return [
        {
          id: deployment,
          name: `Azure: ${deployment}`,
          provider: 'azure-openai',
          reasoning: false,
          input: ['text', 'image'],
        },
      ];
    }
    // Fall back to the saved Azure entry regardless of which provider is
    // currently active — keeps the deployment visible after switching away
    // and back.
    const azureEntry = loadPersistedStore().providers['azure-openai'];
    if (azureEntry?.model) {
      return [
        {
          id: azureEntry.model,
          name: `Azure: ${azureEntry.model}`,
          provider: 'azure-openai',
          reasoning: false,
          input: ['text', 'image'],
        },
      ];
    }
  }

  return [];
}

/**
 * Like {@link getModelsForProvider}, but for GitHub Copilot it returns the
 * models the *current account* is actually entitled to — queried live from
 * Copilot's `GET /models` endpoint (the same source VS Code's model picker
 * uses).
 *
 * The returned list is the live entitlement, enriched per model:
 *   - If pi-ai's static registry knows the id, we reuse its curated entry
 *     (accurate reasoning flag, input modalities, display name, and — via
 *     {@link buildModel} — the optimal request protocol).
 *   - Otherwise the model is newer than the bundled registry; we surface it
 *     anyway using the live metadata. Such models are requested over the
 *     universal `openai-completions` endpoint (see {@link buildModel}),
 *     which Copilot's gateway accepts for every chat model, so they remain
 *     usable until a pi-ai upgrade restores the optimal protocol.
 *
 * Falls back to the full static list when unauthenticated or the live fetch
 * fails, preserving the previous behavior.
 */
export async function getModelsForProviderLive(
  providerId: string,
): Promise<LLMModelInfo[]> {
  const staticModels = getModelsForProvider(providerId);
  if (providerId !== 'github-copilot') return staticModels;

  const entitled = await fetchEntitledCopilotModels();
  if (!entitled || entitled.length === 0) return staticModels;

  const staticById = new Map(staticModels.map((m) => [m.id.toLowerCase(), m]));
  return entitled.map((live) => {
    const known = staticById.get(live.id.toLowerCase());
    if (known) return known;
    return {
      id: live.id,
      name: live.name,
      provider: 'github-copilot',
      reasoning: false,
      input: live.vision ? ['text', 'image'] : ['text'],
    } satisfies LLMModelInfo;
  });
}

/**
 * Get the current LLM configuration.
 *
 * For OAuth providers this performs an authoritative `authenticated` check
 * (refreshing the access token if needed) so the Settings UI can't show
 * "logged in" while the persisted credentials no longer work. Cost: a
 * single network round-trip only when the access token is past its expiry;
 * otherwise it's a local memory check.
 */
export async function getLLMConfig(): Promise<LLMConfig> {
  try {
    const cfg = ensureConfig();
    const catalog = getProviderCatalog();
    const providerInfo = catalog.find((p) => p.id === cfg.provider);
    const isOAuth = providerInfo?.authType === 'oauth';

    // For OAuth providers, verify credentials are actually usable
    // (not just present on disk) — fixes the bug where Settings
    // displayed "logged in" while the agent failed at request time.
    const authenticated = isOAuth
      ? await verifyOAuthCredentials(cfg.provider)
      : !!resolveApiKey(cfg.provider);

    return {
      provider: cfg.provider,
      model: cfg.model,
      authenticated,
      baseUrl: cfg.baseUrl,
      apiVersion: cfg.apiVersion,
    };
  } catch (err) {
    log.warn({ err }, 'Failed to load LLM config');
    return {
      provider: '',
      model: '',
      authenticated: false,
    };
  }
}

/**
 * Update the active LLM provider/model configuration.
 *
 * Persisted as a per-provider map (see {@link PersistedStore}): switching
 * to a different provider keeps the previous provider's saved fields on
 * disk, so switching back later restores its model / endpoint / api
 * version / key without re-entry. Within the same provider, fields
 * omitted from `update` keep their previously-saved values.
 *
 * Returns an authoritative `authenticated` flag for OAuth providers —
 * see {@link getLLMConfig} for the rationale.
 */
export async function setLLMConfig(
  update: LLMConfigUpdate,
): Promise<LLMConfig> {
  const store = loadPersistedStore();
  const existingEntry: ProviderPersisted =
    store.providers[update.provider] ?? {};

  // Resolve the effective model: explicit > previously saved > first
  // built-in default (so the first time you switch to a registry-backed
  // provider you get a working model id without having to type one).
  let resolvedModel = update.model || existingEntry.model || '';
  if (!resolvedModel) {
    const providerInfo = getProviderCatalog().find(
      (p) => p.id === update.provider,
    );
    if (providerInfo?.builtIn) {
      const models = getModelsForProvider(update.provider);
      if (models.length > 0) resolvedModel = models[0].id;
    }
  }

  // Build the merged entry. `apiKey` / `baseUrl` / `apiVersion` semantics:
  // omitted (undefined) → keep previous; empty string → clear.
  const entry: ProviderPersisted = { ...existingEntry, model: resolvedModel };
  if (update.apiKey !== undefined) {
    if (update.apiKey) entry.apiKey = update.apiKey;
    else delete entry.apiKey;
  }
  if (update.baseUrl !== undefined) {
    if (update.baseUrl) entry.baseUrl = update.baseUrl;
    else delete entry.baseUrl;
  }
  if (update.apiVersion !== undefined) {
    if (update.apiVersion) entry.apiVersion = update.apiVersion;
    else delete entry.apiVersion;
  }
  store.providers[update.provider] = entry;
  store.active = update.provider;
  savePersistedStore(store);

  const persisted = buildPersistedConfig(store, update.provider) ?? {
    provider: update.provider,
    model: resolvedModel,
  };
  activeConfig = persisted;
  cachedModel = null;
  cachedApiKey = null;

  const providerInfo = getProviderCatalog().find(
    (p) => p.id === persisted.provider,
  );
  const isOAuth = providerInfo?.authType === 'oauth';
  const authenticated = isOAuth
    ? await verifyOAuthCredentials(persisted.provider)
    : !!resolveApiKey(persisted.provider, persisted.apiKey);

  return {
    provider: persisted.provider,
    model: persisted.model,
    authenticated,
    baseUrl: persisted.baseUrl,
    apiVersion: persisted.apiVersion,
  };
}

/**
 * Get the currently saved image-generation configuration. Independent
 * of {@link getLLMConfig} so chat and image can target different
 * providers / endpoints / keys.
 *
 * Returns an empty (`provider:''`, `authenticated:false`) config when
 * nothing has been saved yet — callers should treat that as "image
 * generation not configured" rather than an error.
 */
export function getImageConfig(): LLMImageConfig {
  const image = loadPersistedStore().imageConfig;
  if (!image) {
    return { provider: '', authenticated: false };
  }
  return {
    provider: image.provider ?? '',
    authenticated: !!image.apiKey,
    ...(image.baseUrl ? { baseUrl: image.baseUrl } : {}),
    ...(image.model ? { model: image.model } : {}),
    ...(image.modelFamily ? { modelFamily: image.modelFamily } : {}),
    ...(image.apiVersion ? { apiVersion: image.apiVersion } : {}),
    ...(image.quality ? { quality: image.quality } : {}),
  };
}

/**
 * Update the image-generation configuration. Same omission semantics
 * as {@link setLLMConfig}: a field that is `undefined` in `update`
 * keeps its previously-saved value; an empty string clears it.
 */
export function setImageConfig(update: LLMImageConfigUpdate): LLMImageConfig {
  const store = loadPersistedStore();
  const existing: ImageConfigPersisted = store.imageConfig ?? {};
  const next: ImageConfigPersisted = { ...existing };

  if (update.provider !== undefined) {
    if (update.provider) next.provider = update.provider;
    else delete next.provider;
  }
  if (update.baseUrl !== undefined) {
    if (update.baseUrl) next.baseUrl = update.baseUrl;
    else delete next.baseUrl;
  }
  if (update.model !== undefined) {
    if (update.model) next.model = update.model;
    else delete next.model;
  }
  if (update.modelFamily !== undefined) {
    next.modelFamily = update.modelFamily;
  }
  if (update.apiVersion !== undefined) {
    if (update.apiVersion) next.apiVersion = update.apiVersion;
    else delete next.apiVersion;
  }
  if (update.apiKey !== undefined) {
    if (update.apiKey) next.apiKey = update.apiKey;
    else delete next.apiKey;
  }
  if (update.quality !== undefined) {
    // Enum schema rejects empty strings, so a present value always
    // overwrites. Absent means "keep".
    next.quality = update.quality;
  }

  store.imageConfig = next;
  savePersistedStore(store);
  return getImageConfig();
}

/**
 * Resolved Azure image-generation config, for the `generate_image`
 * agent tool. Reads from the dedicated top-level `imageConfig`
 * (independent of which chat provider is active) so users can pair an
 * Azure image deployment with any chat provider.
 *
 * Throws a user-actionable error when any required field is missing
 * so the agent tool surfaces a clear "open Settings" message in chat
 * instead of a cryptic 4xx from Azure.
 */
export function getAzureImageConfig(): {
  endpoint: string;
  deployment: string;
  apiKey: string;
  apiVersion: string;
  /** Model family driving capability lookups (sizes / qualities). */
  modelFamily: ImageModelFamily;
  /**
   * Optional default quality override from Settings. When absent the
   * caller should fall back to the family's `defaultQuality` from the
   * shared capability registry.
   */
  quality?: 'low' | 'medium' | 'high' | 'auto';
} {
  const image = loadPersistedStore().imageConfig;
  const provider = image?.provider ?? '';
  if (provider && provider !== 'azure-openai') {
    throw new Error(
      `Image provider "${provider}" is not supported yet. Open Settings → Image Provider and select Azure OpenAI.`,
    );
  }
  const endpoint = image?.baseUrl?.replace(/\/+$/, '') ?? '';
  const explicitDeployment = image?.model?.trim() ?? '';
  const apiKey = image?.apiKey ?? '';
  // Fall back to the same default the Settings input is pre-filled
  // with, so users who never touched the API Version field (and thus
  // never triggered a save for it) still get a working request.
  const apiVersion =
    image?.apiVersion?.trim() || DEFAULT_AZURE_IMAGE_API_VERSION;
  // Legacy configs (saved before `modelFamily` existed) all targeted
  // gpt-image-2, so that's the safe default — no heuristic guessing
  // from the deployment string is required.
  const modelFamily: ImageModelFamily = isImageModelFamily(image?.modelFamily)
    ? image!.modelFamily!
    : DEFAULT_IMAGE_MODEL_FAMILY;
  // Most users name their Azure deployment after the model itself, so
  // when the Deployment field is blank we fall back to the model family
  // name. Users with custom deployment names still set it explicitly.
  const deployment = explicitDeployment || modelFamily;
  const missing: string[] = [];
  if (!endpoint) missing.push('Endpoint');
  if (!apiKey) missing.push('API Key');
  if (missing.length > 0) {
    throw new Error(
      `Azure image generation not configured. Open Settings → Image Provider → Azure OpenAI and fill in: ${missing.join(', ')}.`,
    );
  }
  return {
    endpoint,
    deployment,
    apiKey,
    apiVersion,
    modelFamily,
    ...(image?.quality ? { quality: image.quality } : {}),
  };
}

/**
 * Best-effort read of the currently configured image model family,
 * for callers that only need capability metadata (e.g. dynamic
 * `generate_image` tool-description injection) and must not throw
 * when image generation is unconfigured. Falls back to
 * {@link DEFAULT_IMAGE_MODEL_FAMILY}.
 */
export function getConfiguredImageModelFamily(): ImageModelFamily {
  const family = loadPersistedStore().imageConfig?.modelFamily;
  return isImageModelFamily(family) ? family : DEFAULT_IMAGE_MODEL_FAMILY;
}

// ==================== Utility-tier config ====================

/**
 * Project `store.utilityConfig` down to a `PersistedConfig`, or `null`
 * when the utility tier is unconfigured / following the chat model.
 *
 * No `apiKey` is attached — it is resolved per-provider at call time via
 * {@link resolveApiKey} / {@link resolveApiKeyAsync}, so the key entered in
 * the utility panel (stored in the shared `providers` map) is reused.
 */
function loadUtilityPersistedConfig(): PersistedConfig | null {
  const u = loadPersistedStore().utilityConfig;
  if (!u || !u.provider) return null;
  return {
    provider: u.provider,
    model: u.model ?? '',
    ...(u.baseUrl ? { baseUrl: u.baseUrl } : {}),
    ...(u.apiVersion ? { apiVersion: u.apiVersion } : {}),
  };
}

/**
 * Get the saved utility-tier configuration. An empty `provider` (the
 * default) means "follow the chat model". `authenticated` reflects whether
 * the chosen provider is usable: for OAuth providers it performs an
 * authoritative credential check (shared with the chat config, so logging
 * in once covers both tiers); for API-key providers it checks the shared
 * per-provider store / env. This lets the Settings UI show whether an
 * inline key is still needed, and never asks OAuth providers for a key.
 */
export async function getUtilityConfig(): Promise<LLMUtilityConfig> {
  const u = loadPersistedStore().utilityConfig;
  if (!u || !u.provider) {
    return { provider: '', model: '', authenticated: false };
  }
  const providerInfo = getProviderCatalog().find((p) => p.id === u.provider);
  const isOAuth = providerInfo?.authType === 'oauth';
  const authenticated = isOAuth
    ? await verifyOAuthCredentials(u.provider)
    : !!resolveApiKey(u.provider);
  return {
    provider: u.provider,
    model: u.model ?? '',
    authenticated,
    ...(u.baseUrl ? { baseUrl: u.baseUrl } : {}),
    ...(u.apiVersion ? { apiVersion: u.apiVersion } : {}),
  };
}

/**
 * Update the utility-tier configuration.
 *
 * Semantics mirror {@link setLLMConfig}: an empty `provider` clears the
 * utility entry (→ follow chat); otherwise the model resolves to
 * explicit > previously-saved > first built-in default. `baseUrl` /
 * `apiVersion` follow the omit=keep / empty=clear rule.
 *
 * The optional `apiKey` is written into the **shared** `providers` map
 * (not into `utilityConfig`), so entering a key here authenticates that
 * provider for both chat and utility (v1.5 inline-key flow).
 */
export async function setUtilityConfig(
  update: LLMUtilityConfigUpdate,
): Promise<LLMUtilityConfig> {
  const store = loadPersistedStore();

  // Empty provider → follow the chat model: drop the utility entry.
  if (!update.provider) {
    delete store.utilityConfig;
    savePersistedStore(store);
    cachedUtilityModel = null;
    return getUtilityConfig();
  }

  const existing: UtilityConfigPersisted = store.utilityConfig ?? {};
  const next: UtilityConfigPersisted = {
    ...existing,
    provider: update.provider,
  };

  // Resolve the effective model (same precedence as setLLMConfig).
  let resolvedModel = update.model || existing.model || '';
  if (!resolvedModel) {
    const providerInfo = getProviderCatalog().find(
      (p) => p.id === update.provider,
    );
    if (providerInfo?.builtIn) {
      const models = getModelsForProvider(update.provider);
      if (models.length > 0) resolvedModel = models[0].id;
    }
  }
  next.model = resolvedModel;

  if (update.baseUrl !== undefined) {
    if (update.baseUrl) next.baseUrl = update.baseUrl;
    else delete next.baseUrl;
  }
  if (update.apiVersion !== undefined) {
    if (update.apiVersion) next.apiVersion = update.apiVersion;
    else delete next.apiVersion;
  }
  store.utilityConfig = next;

  // API key → shared per-provider credential store.
  if (update.apiKey !== undefined) {
    const entry: ProviderPersisted = store.providers[update.provider] ?? {};
    if (update.apiKey) entry.apiKey = update.apiKey;
    else delete entry.apiKey;
    store.providers[update.provider] = entry;
  }

  savePersistedStore(store);
  cachedUtilityModel = null;
  return getUtilityConfig();
}

/**
 * Get the (cached) utility-tier model, or the chat model when utility is
 * following chat. Built like any chat model; the key is applied at call
 * time, so key changes need not invalidate this cache.
 */
function getUtilityModel(): Model<Api> {
  const cfg = loadUtilityPersistedConfig();
  if (!cfg) return getLLMModel();
  if (cachedUtilityModel) return cachedUtilityModel;
  cachedUtilityModel = buildModel(cfg);
  return cachedUtilityModel;
}

/**
 * Resolve `(config, model)` for a role via the two-layer binding:
 * the role's default tier picks chat or utility; utility falls through to
 * chat when unconfigured. A **vision guard** steps a resolved model up to
 * chat when the role may carry an image (`hasImage`) but the model cannot
 * accept image input.
 */
function resolveForRole(
  role: ModelRole,
  opts?: { hasImage?: boolean },
): { cfg: PersistedConfig; model: Model<Api> } {
  const chat = (): { cfg: PersistedConfig; model: Model<Api> } => ({
    cfg: ensureConfig(),
    model: getLLMModel(),
  });

  const info = MODEL_ROLES[role];
  let resolved = chat();
  if (info.defaultTier === 'utility') {
    const utilityCfg = loadUtilityPersistedConfig();
    if (utilityCfg) resolved = { cfg: utilityCfg, model: getUtilityModel() };
  }

  // Vision guard: only relevant when an image is actually being sent.
  if (
    info.vision &&
    opts?.hasImage &&
    !resolved.model.input.includes('image')
  ) {
    resolved = chat();
  }

  return resolved;
}

/**
 * Get a configured pi-ai Model instance for the active provider/model.
 */
export function getLLMModel(): Model<Api> {
  if (cachedModel) return cachedModel;

  const cfg = ensureConfig();
  cachedApiKey = resolveApiKey(cfg.provider, cfg.apiKey);

  // For OAuth providers, resolveApiKey may return null (async refresh needed)
  // Sync check — the actual async resolution happens in llmStream/llmComplete
  if (!cachedApiKey) {
    const provInfo = getProviderCatalog().find((p) => p.id === cfg.provider);
    if (provInfo?.authType !== 'oauth') {
      throw new Error(
        `API key not found for provider "${cfg.provider}". ` +
          `Set the API key in .env or configure via Settings.`,
      );
    }
  }

  cachedModel = buildModel(cfg);
  return cachedModel;
}

/**
 * Ensure we have a valid API key, refreshing OAuth tokens if needed.
 *
 * Exported so callers that own their own LLM call (e.g. pi-agent-core's
 * `getApiKey` callback) can reuse the same provider-aware resolution and
 * OAuth refresh logic without going through `llmStream` / `llmComplete`.
 */
export async function ensureApiKey(): Promise<string> {
  const cfg = ensureConfig();
  const key = await resolveApiKeyAsync(cfg.provider, cfg.apiKey);
  if (!key) {
    const provInfo = getProviderCatalog().find((p) => p.id === cfg.provider);
    throw new Error(
      `Authentication failed for provider "${cfg.provider}". ` +
        (provInfo?.authType === 'oauth'
          ? 'Please log in via Settings.'
          : `Set the API key in .env or configure via Settings.`),
    );
  }
  cachedApiKey = key;
  return key;
}

function getProviderSpecificOptions(
  cfg: PersistedConfig | null,
): Record<string, unknown> {
  if (!cfg) return {};

  if (cfg.provider === 'azure-openai') {
    const opts: Record<string, unknown> = {};
    if (cfg.baseUrl) opts.azureBaseUrl = cfg.baseUrl;
    if (cfg.apiVersion) opts.azureApiVersion = cfg.apiVersion;
    // pi-ai uses model.id as the deployment name by default; passing it
    // explicitly is harmless and keeps intent obvious for future readers.
    if (cfg.model) opts.azureDeploymentName = cfg.model;
    return opts;
  }

  return {};
}

/** Resolve (and OAuth-refresh) the API key for an arbitrary config. */
async function ensureApiKeyFor(cfg: PersistedConfig): Promise<string> {
  const key = await resolveApiKeyAsync(cfg.provider, cfg.apiKey);
  if (!key) {
    const provInfo = getProviderCatalog().find((p) => p.id === cfg.provider);
    throw new Error(
      `Authentication failed for provider "${cfg.provider}". ` +
        (provInfo?.authType === 'oauth'
          ? 'Please log in via Settings.'
          : `Set the API key in .env or configure via Settings.`),
    );
  }
  return key;
}

/**
 * Per-call options: the pi-ai stream options plus the role selector that
 * routes the call to a model tier. `role` defaults to `'chat'`, so
 * existing callers are unaffected. `hasImage` enables the vision guard
 * (see {@link resolveForRole}) — set it when the context carries an image.
 */
export interface LLMCallOptions extends ProviderStreamOptions {
  role?: ModelRole;
  hasImage?: boolean;
}

/**
 * Stream LLM responses with the model for the requested role.
 */
export async function llmStream(context: Context, options?: LLMCallOptions) {
  const { role = 'chat', hasImage, ...streamOptions } = options ?? {};
  const { cfg, model } = resolveForRole(role, { hasImage });
  const apiKey = await ensureApiKeyFor(cfg);
  return piStream(model, context, {
    apiKey,
    ...getProviderSpecificOptions(cfg),
    ...streamOptions,
  });
}

/**
 * Complete (non-streaming) LLM call with the model for the requested role.
 */
export async function llmComplete(context: Context, options?: LLMCallOptions) {
  const { role = 'chat', hasImage, ...streamOptions } = options ?? {};
  const { cfg, model } = resolveForRole(role, { hasImage });
  const apiKey = await ensureApiKeyFor(cfg);
  return piComplete(model, context, {
    apiKey,
    ...getProviderSpecificOptions(cfg),
    ...streamOptions,
  });
}
