// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * LLM Configuration — pi-ai based, multi-provider
 *
 * Supports dynamic provider/model switching at runtime.
 * Non-secret configuration is persisted to data/llm-config.json. API keys
 * use the runtime SecretStore. All settings are changed via the /api/llm routes.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import {
  complete as piComplete,
  getEnvApiKey,
  getModel,
  getModels,
  getProviders,
} from '@earendil-works/pi-ai/compat';

import {
  DEFAULT_AZURE_IMAGE_API_VERSION,
  DEFAULT_IMAGE_MODEL_FAMILY,
  isImageModelFamily,
  MODEL_ROLES,
} from '@huabu/shared';

import {
  getOAuthApiKey,
  verifyOAuthCredentials,
  getCopilotStaticHeaders,
} from './oauth.js';
import { getPiModels, isOAuthProvider } from './pi-models.js';
import { getDataDir } from '../../data-dir.js';
import {
  llmProviderApiKeySecretId,
  SECRET_IDS,
} from '../../security/secret-ids.js';
import {
  getPersistedSecret,
  getSecret,
  setSecret,
} from '../../security/secret-store.js';
import { getLogger } from '../../utils/logger.js';

import type {
  Api,
  Context,
  KnownProvider,
  Model,
  ProviderStreamOptions,
} from '@earendil-works/pi-ai';
import type { BuiltinProvider } from '@earendil-works/pi-ai/compat';
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
} from '@huabu/shared';

const log = getLogger('llm');

// ==================== Provider Catalog ====================

/** Read a built-in provider's model catalog from pi-ai's registry. */
function getProviderModels(providerId: KnownProvider): Model<Api>[] {
  return getModels(providerId as BuiltinProvider) as Model<Api>[];
}

/**
 * APIs that expose OpenAI's `service_tier` stream option. Only models on
 * one of these can carry a per-thread service-tier selector.
 */
const SERVICE_TIER_APIS = new Set([
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
]);

/** Static service-tier value list surfaced for `SERVICE_TIER_APIS` models. */
const SERVICE_TIERS = ['auto', 'flex', 'priority'] as const;

/** Map a pi-ai catalog model to the wire `LLMModelInfo` shape. */
function toModelInfo(m: Model<Api>, providerId: string): LLMModelInfo {
  const reasoningEfforts = getSupportedThinkingLevels(m).filter(
    (level) => level !== 'off',
  );
  const serviceTiers = SERVICE_TIER_APIS.has(m.api) ? [...SERVICE_TIERS] : [];
  return {
    id: m.id,
    name: m.name || m.id,
    provider: providerId,
    reasoning: m.reasoning,
    input: m.input as ('text' | 'image')[],
    ...(m.cost ? { cost: { input: m.cost.input, output: m.cost.output } } : {}),
    ...(typeof m.contextWindow === 'number'
      ? { contextWindow: m.contextWindow }
      : {}),
    ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    ...(serviceTiers.length > 0 ? { serviceTiers } : {}),
  };
}

/** Provider-specific metadata not available from pi-ai's registry. */
const PROVIDER_OVERRIDES: Record<string, Partial<LLMProviderInfo>> = {
  'azure-openai-responses': {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    builtIn: false,
    baseUrl: { overridable: true },
  },
  'github-copilot': {
    authType: 'oauth',
    baseUrl: { overridable: false },
  },
  'openai-codex': {
    authType: 'oauth',
    baseUrl: { overridable: false },
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
  'openai-codex': 'OpenAI Codex',
};

/**
 * Build provider catalog dynamically from pi-ai's registry.
 * Falls back to a reasonable default for unknown providers.
 */
function buildProviderCatalog(): LLMProviderInfo[] {
  const knownProviders = getProviders();
  const catalog: LLMProviderInfo[] = knownProviders.map((id) => {
    const overrides = PROVIDER_OVERRIDES[id];
    const models = getProviderModels(id);
    const api = models[0]?.api ?? 'openai-completions';
    const defaultBaseUrl = models[0]?.baseUrl;
    const baseUrl: LLMProviderInfo['baseUrl'] = {
      ...(defaultBaseUrl ? { default: defaultBaseUrl } : {}),
      ...overrides?.baseUrl,
      overridable: overrides?.baseUrl?.overridable ?? Boolean(defaultBaseUrl),
    };
    return {
      id: overrides?.id ?? id,
      name: PROVIDER_DISPLAY_NAMES[id] ?? id,
      api,
      baseUrl,
      builtIn: overrides?.builtIn ?? true,
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
 *
 * Deliberately carries **no** `apiKey`: credentials are resolved from the
 * SecretStore by provider id, never from `llm-config.json`.
 */
interface PersistedConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
}

/**
 * Per-provider **non-secret** persisted fields. Stored in a map keyed by
 * provider id so switching providers doesn't wipe the previous provider's
 * settings (e.g. switching from Azure → OpenAI → Azure restores the Azure
 * endpoint / deployment / api version exactly as you left them).
 *
 * The provider's api key is deliberately absent: it lives in the SecretStore
 * under {@link llmProviderApiKeySecretId}, so it survives the same switch
 * without ever being written to `llm-config.json`.
 */
interface ProviderPersisted {
  model?: string;
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
   * `@huabu/shared/llm/image-capabilities`). When absent on a
   * legacy entry we default to `gpt-image-2` at read time — that
   * matches the only image model Huabu shipped before this field
   * was introduced.
   */
  modelFamily?: ImageModelFamily;
  apiVersion?: string;
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
   * utility model's credential is resolved from the SecretStore by
   * `provider`, so a key entered in the utility panel is stored once and
   * reused whether the same provider drives chat or utility.
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
 *  1. **Legacy single-config shape** `{ provider, model,
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
 * endpoint / apiVersion when the legacy file already has
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
let activeConfig: PersistedConfig | null = null;

/**
 * Cached utility-tier model. Built from `store.utilityConfig` and
 * invalidated whenever {@link setUtilityConfig} writes. When utility is
 * following the chat model (no utility config), the resolver returns the
 * chat model directly and this stays null.
 */
let cachedUtilityModel: Model<Api> | null = null;

/**
 * Resolve the API key for a provider.
 *
 * The SecretStore is the only source: it covers UI-persisted credentials
 * (encrypted file or Electron `safeStorage`) and deployment-owned environment
 * variables. There is deliberately no caller-supplied or on-disk plaintext
 * fallback.
 */
function resolveApiKey(providerId: string): string | null {
  return getSecret(llmProviderApiKeySecretId(providerId));
}

/**
 * Resolve the API key for OAuth providers (async — may need token refresh).
 * Falls back to resolveApiKey for non-OAuth providers.
 */
async function resolveApiKeyAsync(providerId: string): Promise<string | null> {
  // OAuth providers (GitHub Copilot, OpenAI Codex) resolve an access token.
  if (isOAuthProvider(providerId)) {
    return getOAuthApiKey(providerId);
  }
  return resolveApiKey(providerId);
}

/** Build a Model object for the active configuration. */
function buildModel(cfg: PersistedConfig): Model<Api> {
  const providerInfo = getProviderCatalog().find((p) => p.id === cfg.provider);

  // Try to get from pi-ai built-in registry first
  if (providerInfo?.builtIn) {
    try {
      const builtIn =
        getProviderModels(cfg.provider as KnownProvider).find(
          (model) => model.id === cfg.model,
        ) ?? getModel(cfg.provider as BuiltinProvider, cfg.model as never);
      if (builtIn) {
        let model = builtIn as Model<Api>;
        if (cfg.baseUrl) {
          model = { ...model, baseUrl: cfg.baseUrl };
        }
        // Copilot's credential-specific gateway baseUrl + client headers are
        // applied later, at request time, via applyCopilotAuthToModel
        // (pi-ai Models.getAuth). The registry model already carries the
        // client headers.
        return model;
      }
    } catch {
      // Model not found in registry — build manually
    }
  }

  // Manual model construction (Azure, custom endpoints, etc.)
  //
  // Copilot models present in pi-ai's catalog take the built-in path above
  // with their correct per-model api. This manual path only handles
  // github-copilot ids newer than the bundled catalog: their real api is
  // unknown, so we request them over the universal openai-completions
  // (`/chat/completions`) endpoint, which Copilot's gateway accepts for
  // every chat model.
  const api =
    cfg.provider === 'github-copilot'
      ? 'openai-completions'
      : (providerInfo?.api ?? 'openai-completions');
  let baseUrl = cfg.baseUrl ?? providerInfo?.baseUrl.default ?? '';

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

  // Copilot ids newer than the bundled catalog have no registry entry, so
  // seed the required client headers (`Editor-Version`,
  // `Copilot-Integration-Id`, …) here — otherwise the request is rejected
  // with `400 missing Editor-Version header for IDE auth`. The
  // credential-specific baseUrl is applied later via applyCopilotAuthToModel.
  if (cfg.provider === 'github-copilot') {
    model = {
      ...model,
      headers: getCopilotStaticHeaders(),
    } as Model<Api>;
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
      const models = getProviderModels(providerId as KnownProvider);
      return models.map((m) => toModelInfo(m, providerId));
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
 * Model-id substrings that are never chat/completion models on the OpenAI
 * API. OpenAI's `/v1/models` list mixes in embedding, audio, image, and
 * moderation models that Huabu's chat settings must not surface. Mirrors
 * the filter Open WebUI and similar clients apply.
 */
const OPENAI_NON_CHAT_MODEL_MARKERS = [
  'babbage',
  'davinci',
  'dall-e',
  'embedding',
  'tts',
  'whisper',
  'image',
  'audio',
  'realtime',
  'transcribe',
  'moderation',
] as const;

const OPENAI_MODEL_IDS_CACHE_TTL_MS = 5 * 60_000;
let openAIModelIdsCache: { ids: string[]; expiresAt: number } | null = null;
let openAIModelIdsRequest: Promise<string[] | null> | null = null;
/**
 * Bumped whenever the OpenAI key / baseUrl changes. An in-flight
 * `/v1/models` fetch started under the previous credential captures the
 * epoch at launch and, if it no longer matches on completion, neither
 * repopulates the cache (stale-key ids) nor clears a newer in-flight
 * request.
 */
let openAIModelIdsEpoch = 0;

/** Whether an OpenAI `/v1/models` id is a chat/completion model. */
export function isOpenAIChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !OPENAI_NON_CHAT_MODEL_MARKERS.some((marker) =>
    lower.includes(marker),
  );
}

/**
 * Merge live OpenAI model ids with the static pi-ai catalogue:
 *   - Known ids reuse the curated static entry (accurate reasoning flag,
 *     input modalities, display name).
 *   - Unknown ids (newer than the bundled registry) are surfaced with
 *     conservative defaults: multimodal input (all current OpenAI chat
 *     models accept text + image) and no reasoning flag until a pi-ai
 *     upgrade supplies the real metadata.
 *
 * The result preserves the live ordering so the account's own entitlement
 * drives what the user sees. Falls back to the full static list when the
 * live ids yield nothing selectable.
 */
export function mergeOpenAIModels(
  liveIds: string[],
  staticModels: LLMModelInfo[],
): LLMModelInfo[] {
  const staticById = new Map(staticModels.map((m) => [m.id.toLowerCase(), m]));
  const seen = new Set<string>();
  const merged: LLMModelInfo[] = [];
  for (const id of liveIds) {
    if (!isOpenAIChatModelId(id)) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const known = staticById.get(key);
    merged.push(
      known ?? {
        id,
        name: id,
        provider: 'openai',
        reasoning: false,
        input: ['text', 'image'],
      },
    );
  }
  return merged.length > 0 ? merged : staticModels;
}

/**
 * Fetch the model ids the current OpenAI API key can access from
 * `GET {baseUrl}/models`. Returns `null` when unauthenticated, unreachable,
 * or the response is unusable — letting callers fall back to the static
 * pi-ai catalogue instead of showing an empty list.
 */
async function fetchOpenAIModelIds(): Promise<string[] | null> {
  if (openAIModelIdsCache && openAIModelIdsCache.expiresAt > Date.now()) {
    return [...openAIModelIdsCache.ids];
  }
  if (openAIModelIdsRequest) return openAIModelIdsRequest;

  const epoch = openAIModelIdsEpoch;
  openAIModelIdsRequest = fetchOpenAIModelIdsUncached();
  try {
    const ids = await openAIModelIdsRequest;
    // Drop the result if the credential changed mid-flight — a stale-key
    // model list must not seed the cache for the new key.
    if (ids && epoch === openAIModelIdsEpoch) {
      openAIModelIdsCache = {
        ids: [...ids],
        expiresAt: Date.now() + OPENAI_MODEL_IDS_CACHE_TTL_MS,
      };
    }
    return ids;
  } finally {
    // Only clear our own request slot; a config change may have already
    // installed a fresh request for the new credential.
    if (epoch === openAIModelIdsEpoch) openAIModelIdsRequest = null;
  }
}

async function fetchOpenAIModelIdsUncached(): Promise<string[] | null> {
  const apiKey = await resolveApiKeyAsync('openai');
  if (!apiKey) return null;

  const providerInfo = getProviderCatalog().find((p) => p.id === 'openai');
  const persistedBaseUrl = loadPersistedStore().providers['openai']?.baseUrl;
  const baseUrl = (
    persistedBaseUrl ??
    providerInfo?.baseUrl.default ??
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn(
        { status: res.status },
        'OpenAI /v1/models returned non-OK HTTP status',
      );
      return null;
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = Array.isArray(json.data)
      ? json.data
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    return ids.length > 0 ? ids : null;
  } catch (err) {
    log.warn({ err }, 'Failed to fetch OpenAI /v1/models');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Like {@link getModelsForProvider}, but resolves the *current account's*
 * live entitlement for the providers that expose one:
 *   - GitHub Copilot: pi-ai's `Models.getAvailable`, which filters the
 *     bundled Copilot catalog by the `availableModelIds` captured on the
 *     stored OAuth credential at login/refresh (no per-call network round
 *     trip).
 *   - OpenAI: queried from `GET {baseUrl}/models`, filtered to chat models
 *     and merged with the static pi-ai metadata (see
 *     {@link mergeOpenAIModels}).
 *
 * Falls back to the full static list when unauthenticated or the live
 * lookup fails, preserving the previous behavior.
 */
export async function getModelsForProviderLive(
  providerId: string,
): Promise<LLMModelInfo[]> {
  const staticModels = getModelsForProvider(providerId);

  // OpenAI: prefer the account's live `/v1/models` entitlement, merged with
  // the static pi-ai metadata; fall back to the static catalogue on failure.
  if (providerId === 'openai') {
    const liveIds = await fetchOpenAIModelIds();
    return liveIds ? mergeOpenAIModels(liveIds, staticModels) : staticModels;
  }

  if (providerId !== 'github-copilot') return staticModels;

  // Copilot: getAvailable() narrows the bundled catalog to the account's
  // entitled `availableModelIds` (captured on the credential at login /
  // token refresh). It returns [] when unauthenticated — fall back to the
  // static catalog in that case.
  try {
    const available = await getPiModels().getAvailable('github-copilot');
    if (available.length === 0) return staticModels;
    return available.map((m) => toModelInfo(m, providerId));
  } catch (err) {
    log.warn({ err }, 'Copilot getAvailable failed; using static catalog');
    return staticModels;
  }
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

  // Build the merged entry. `baseUrl` / `apiVersion` semantics: omitted
  // (undefined) → keep previous; empty string → clear. The same rule applies
  // to `apiKey`, which is written to the SecretStore rather than this entry.
  const entry: ProviderPersisted = { ...existingEntry, model: resolvedModel };
  // The api key lives in the secret store while the rest lives in a plain
  // config file — two subsystems that cannot be written atomically. Snapshot
  // the previous key so a failed config write can be rolled back, keeping the
  // two stores from diverging on a partial update.
  let apiKeySecretId: string | null = null;
  let previousApiKey: string | null = null;
  if (update.apiKey !== undefined) {
    apiKeySecretId = llmProviderApiKeySecretId(update.provider);
    previousApiKey = getPersistedSecret(apiKeySecretId);
    await setSecret(apiKeySecretId, update.apiKey || null);
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
  try {
    savePersistedStore(store);
  } catch (error) {
    if (apiKeySecretId !== null) {
      try {
        await setSecret(apiKeySecretId, previousApiKey);
      } catch (rollbackError) {
        // Both the config write AND the api-key rollback failed: the secret
        // store and the plain config file are now inconsistent (the new key
        // may be persisted while provider/model stayed at their old values).
        // Log loudly and tell the caller this was a partial commit rather
        // than swallowing the rollback failure.
        log.error(
          { err: error, rollbackError, provider: update.provider },
          'LLM config write failed and api-key rollback also failed; ' +
            'secret store and config file are now inconsistent',
        );
        const configMessage =
          error instanceof Error ? error.message : String(error);
        const rollbackMessage =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        throw new Error(
          `LLM settings partially committed: config write failed (${configMessage}) ` +
            `and api-key rollback failed (${rollbackMessage}); the new key may be ` +
            'persisted while provider/model remain at their previous values',
        );
      }
    }
    throw error;
  }

  const persisted = buildPersistedConfig(store, update.provider) ?? {
    provider: update.provider,
    model: resolvedModel,
  };
  activeConfig = persisted;
  cachedModel = null;
  if (
    persisted.provider === 'openai' &&
    (update.apiKey !== undefined || update.baseUrl !== undefined)
  ) {
    openAIModelIdsCache = null;
    openAIModelIdsRequest = null;
    openAIModelIdsEpoch += 1;
  }

  const providerInfo = getProviderCatalog().find(
    (p) => p.id === persisted.provider,
  );
  const isOAuth = providerInfo?.authType === 'oauth';
  const authenticated = isOAuth
    ? await verifyOAuthCredentials(persisted.provider)
    : !!resolveApiKey(persisted.provider);

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
    authenticated: Boolean(getPersistedSecret(SECRET_IDS.imageApiKey)),
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
export async function setImageConfig(
  update: LLMImageConfigUpdate,
): Promise<LLMImageConfig> {
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
    await setSecret(SECRET_IDS.imageApiKey, update.apiKey || null);
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
  const apiKey = getSecret(SECRET_IDS.imageApiKey) ?? '';
  // Fall back to the same default the Settings input is pre-filled
  // with, so users who never touched the API Version field (and thus
  // never triggered a save for it) still get a working request.
  const apiVersion =
    image?.apiVersion?.trim() || DEFAULT_AZURE_IMAGE_API_VERSION;
  // Legacy configs (saved before `modelFamily` existed) all targeted
  // gpt-image-2, so that's the safe default — no heuristic guessing
  // from the deployment string is required.
  const configuredModelFamily = image?.modelFamily;
  const modelFamily: ImageModelFamily = isImageModelFamily(
    configuredModelFamily,
  )
    ? configuredModelFamily
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
 * the utility panel (stored in the SecretStore) is reused.
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
 * default) means "auto": background roles run on the cheapest eligible
 * model in the authenticated chat provider (resolved at call time by
 * {@link resolveAutoCheapUtility}), falling back to the chat model.
 * `authenticated` reflects whether the chosen provider is usable: for OAuth
 * providers it performs an authoritative credential check (shared with the
 * chat config, so logging in once covers both tiers); for API-key providers
 * it checks the shared per-provider store / env. This lets the Settings UI
 * show whether an inline key is still needed, and never asks OAuth
 * providers for a key.
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
 * The optional `apiKey` is written into the **shared** per-provider
 * SecretStore entry (not into `utilityConfig`), so entering a key here
 * authenticates that provider for both chat and utility (v1.5 inline-key
 * flow).
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
    await setSecret(
      llmProviderApiKeySecretId(update.provider),
      update.apiKey || null,
    );
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
 * Vision guard predicate: a vision-capable role that is carrying an image
 * this turn must not run on a model that cannot accept image input. When
 * this returns `true` the caller steps the resolved model back up to the
 * (always vision-capable) chat model. Pure over its inputs so the fallback
 * logic can be unit-tested without the persisted-store / secret machinery.
 */
export function shouldStepUpForVision(
  role: ModelRole,
  modelInput: readonly string[],
  hasImage: boolean | undefined,
): boolean {
  return Boolean(
    MODEL_ROLES[role].vision && hasImage && !modelInput.includes('image'),
  );
}

/**
 * Pick the cheapest known-priced model from a pi-ai model list, ranked by
 * combined per-token input + output price. Entries without a positive
 * input price are skipped so zero-priced or unpriced registry entries can't
 * masquerade as "free" and win.
 * Returns `null` when no priced model is available. Pure over its input so
 * the ranking can be unit-tested without the registry.
 */
export function pickCheapestModel(models: Model<Api>[]): Model<Api> | null {
  let best: Model<Api> | null = null;
  let bestPrice = Infinity;
  for (const m of models) {
    const inputCost = m.cost?.input ?? 0;
    const outputCost = m.cost?.output ?? 0;
    if (inputCost <= 0) continue;
    const price = inputCost + outputCost;
    if (price < bestPrice) {
      bestPrice = price;
      best = m;
    }
  }
  return best;
}

/** Pick the cheapest model whose id is present in the provider entitlement. */
export function pickCheapestEligibleModel(
  models: Model<Api>[],
  eligibleModelIds: ReadonlySet<string>,
): Model<Api> | null {
  return pickCheapestModel(
    models.filter((model) => eligibleModelIds.has(model.id)),
  );
}

/**
 * When the utility tier is following chat (no explicit utility config),
 * resolve the cheapest known-priced model within the authenticated chat
 * provider so lightweight background roles (labeling / summaries /
 * keywords) don't burn the flagship chat model's per-token rate — the
 * utility credential is the chat provider's, so this needs no extra auth.
 *
 * Returns `null` for non-built-in providers, for subscription OAuth providers
 * without a reliable entitlement source (OpenAI Codex), when no priced model
 * is available, or when the cheapest already is the active chat model, so the
 * caller cleanly falls back to the (cached) chat model.
 */
async function resolveAutoCheapUtility(
  chatCfg: PersistedConfig,
): Promise<{ cfg: PersistedConfig; model: Model<Api> } | null> {
  const providerInfo = getProviderCatalog().find(
    (p) => p.id === chatCfg.provider,
  );
  if (!providerInfo?.builtIn) return null;

  // Subscription-based OAuth providers other than GitHub Copilot (i.e. OpenAI
  // Codex) expose no reliable per-account entitlement: pi-ai's `getAvailable`
  // returns their full static catalog (no `filterModels`, no
  // `availableModelIds` on the credential), and the "cheapest" ranking is
  // meaningless for a flat-rate subscription. Picking by price would surface
  // models the ChatGPT plan cannot use (e.g. `gpt-5.3-codex-spark`) and the
  // request would fail server-side with no fallback. Stay on the chat model.
  if (
    isOAuthProvider(chatCfg.provider) &&
    chatCfg.provider !== 'github-copilot'
  )
    return null;

  let catalog: Model<Api>[];
  try {
    catalog = getProviderModels(chatCfg.provider as KnownProvider);
  } catch (err) {
    log.warn(
      { err, provider: chatCfg.provider },
      'Failed to load provider catalog for automatic utility selection',
    );
    return null;
  }

  let eligibleModelIds: Set<string>;
  try {
    // `Models.getAvailable` narrows a provider's catalog to the ids the
    // stored credential is entitled to (Copilot's `availableModelIds`, an
    // OAuth account's model list, …) — the same source
    // getModelsForProviderLive uses — so background selection can never pick
    // a model the account is not entitled to.
    const available = await getPiModels().getAvailable(chatCfg.provider);
    eligibleModelIds = new Set(available.map((model) => model.id));

    // OpenAI's provider catalog is static, so additionally intersect it with
    // the current API key's live /v1/models entitlement. A failed lookup is
    // not permission to guess: fall back to the configured chat model.
    if (chatCfg.provider === 'openai') {
      const liveIds = await fetchOpenAIModelIds();
      if (!liveIds) return null;
      const liveIdSet = new Set(liveIds);
      eligibleModelIds = new Set(
        [...eligibleModelIds].filter((id) => liveIdSet.has(id)),
      );
    }
  } catch (err) {
    log.warn(
      { err, provider: chatCfg.provider },
      'Failed to resolve eligible models for automatic utility selection',
    );
    return null;
  }

  const cheapest = pickCheapestEligibleModel(catalog, eligibleModelIds);
  if (!cheapest || cheapest.id === chatCfg.model) return null;

  const cfg: PersistedConfig = { ...chatCfg, model: cheapest.id };
  return { cfg, model: buildModel(cfg) };
}

/**
 * Resolve `(config, model)` synchronously for callers that cannot consult
 * account entitlements. An explicit utility model is safe to resolve here;
 * automatic utility selection conservatively stays on the chat model and is
 * applied by {@link resolveForRoleAsync} on runtime request paths.
 *
 * The two-layer binding is:
 * the role's default tier picks chat or utility. Utility resolution order
 * is **explicit utility model > auto-cheapest in the chat provider > chat
 * model**: when no utility model is configured, background roles default to
 * the cheapest eligible model in the authenticated chat provider (see
 * {@link resolveAutoCheapUtility}) instead of the flagship chat model. A
 * **vision guard** then steps a resolved model up to chat when the role may
 * carry an image (`hasImage`) but the model cannot accept image input.
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
    if (utilityCfg) {
      // Explicit utility model wins.
      resolved = { cfg: utilityCfg, model: getUtilityModel() };
    }
  }

  // Vision guard: only relevant when an image is actually being sent.
  if (shouldStepUpForVision(role, resolved.model.input, opts?.hasImage)) {
    resolved = chat();
  }

  return resolved;
}

/** Resolve a role for runtime use, including account-aware auto selection. */
async function resolveForRoleAsync(
  role: ModelRole,
  opts?: { hasImage?: boolean },
): Promise<{ cfg: PersistedConfig; model: Model<Api> }> {
  let resolved = resolveForRole(role, opts);
  const info = MODEL_ROLES[role];

  if (info.defaultTier === 'utility' && loadUtilityPersistedConfig() === null) {
    const autoCheap = await resolveAutoCheapUtility(ensureConfig());
    if (autoCheap) resolved = autoCheap;
  }

  if (shouldStepUpForVision(role, resolved.model.input, opts?.hasImage)) {
    resolved = { cfg: ensureConfig(), model: getLLMModel() };
  }

  return resolved;
}

/**
 * Resolve GitHub Copilot's credential-specific request context onto a model:
 * the gateway `baseUrl` (derived by pi-ai from the OAuth token's `proxy-ep`)
 * and the client headers, both via `Models.getAuth(model)`. This retires the
 * hand-rolled token→baseUrl derivation. Non-Copilot models pass through
 * unchanged; an unauthenticated Copilot returns the model untouched (the
 * caller's api-key resolution then surfaces the "please log in" error).
 */
async function applyCopilotAuthToModel(
  cfg: PersistedConfig,
  model: Model<Api>,
): Promise<Model<Api>> {
  if (cfg.provider !== 'github-copilot') return model;
  const result = await getPiModels().getAuth(model);
  if (!result) return model;
  // pi-ai's ProviderHeaders allows null values; Model.headers is string-only,
  // so drop any null-valued headers before applying.
  const headers = result.auth.headers
    ? Object.fromEntries(
        Object.entries(result.auth.headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : undefined;
  return {
    ...model,
    ...(result.auth.baseUrl ? { baseUrl: result.auth.baseUrl } : {}),
    ...(headers ? { headers } : {}),
  };
}

/**
 * Resolve a role's model for runtime use, also resolving GitHub Copilot's
 * credential-specific gateway baseUrl + client headers via pi-ai
 * `Models.getAuth`. Streaming paths must use this so Copilot requests hit the
 * correct per-account gateway with the required headers.
 */
export async function resolveModelForRoleAsync(
  role: ModelRole,
  opts?: { hasImage?: boolean },
): Promise<Model<Api>> {
  const { cfg, model } = await resolveForRoleAsync(role, opts);
  return applyCopilotAuthToModel(cfg, model);
}

/**
 * Resolve a specific model id for runtime use, applying GitHub Copilot's
 * credential-specific gateway auth like {@link resolveModelForRoleAsync}.
 *
 * Used by the built-in agent's per-thread model override: the selection
 * stays within the **active provider** (only the model id changes), so the
 * provider api key resolved for the chat role still applies and no separate
 * credential lookup is needed.
 */
export async function resolveModelByIdAsync(
  modelId: string,
): Promise<Model<Api>> {
  const cfg: PersistedConfig = { ...ensureConfig(), model: modelId };
  const model = buildModel(cfg);
  return applyCopilotAuthToModel(cfg, model);
}

/** Resolve and authenticate the provider configured for a workload role. */
export async function ensureApiKeyForRole(
  role: ModelRole,
  opts?: { hasImage?: boolean },
): Promise<string> {
  // Automatic utility selection stays within the chat provider, so resolving
  // the provider synchronously avoids repeating its entitlement lookup after
  // resolveModelForRoleAsync() has already selected the model.
  const { cfg } = resolveForRole(role, opts);
  return ensureApiKeyFor(cfg);
}

/**
 * Get a configured pi-ai Model instance for the active provider/model.
 */
export function getLLMModel(): Model<Api> {
  if (cachedModel) return cachedModel;

  const cfg = ensureConfig();
  const apiKey = resolveApiKey(cfg.provider);

  // For OAuth providers, resolveApiKey may return null (async refresh needed)
  // Sync check — the actual async resolution happens in llmComplete
  if (!apiKey) {
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
 * OAuth refresh logic without going through `llmComplete`.
 */
export async function ensureApiKey(): Promise<string> {
  const cfg = ensureConfig();
  const key = await resolveApiKeyAsync(cfg.provider);
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
  const key = await resolveApiKeyAsync(cfg.provider);
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
 * Complete (non-streaming) LLM call with the model for the requested role.
 */
export async function llmComplete(context: Context, options?: LLMCallOptions) {
  const { role = 'chat', hasImage, ...streamOptions } = options ?? {};
  const { cfg, model } = await resolveForRoleAsync(role, { hasImage });
  const [resolvedModel, apiKey] = await Promise.all([
    applyCopilotAuthToModel(cfg, model),
    ensureApiKeyFor(cfg),
  ]);
  return piComplete(resolvedModel, context, {
    apiKey,
    ...getProviderSpecificOptions(cfg),
    ...streamOptions,
  });
}
