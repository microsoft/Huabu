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
  getCopilotApiKey,
  verifyOAuthCredentials,
  applyCopilotModelOverrides,
} from './oauth.js';

import type {
  Api,
  Context,
  KnownProvider,
  Model,
  ProviderStreamOptions,
} from '@earendil-works/pi-ai';
import type {
  LLMConfig,
  LLMConfigUpdate,
  LLMModelInfo,
  LLMProviderInfo,
} from '@sediment/shared';

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
  return join(process.cwd(), 'data', filename);
}

const CONFIG_FILE = getDataFilePath('llm-config.json');

interface PersistedConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

function loadPersistedConfig(): PersistedConfig | null {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(raw) as PersistedConfig;
    }
  } catch {
    // Corrupted or missing file — fall through
  }
  return null;
}

function savePersistedConfig(cfg: PersistedConfig): void {
  const dir = dirname(CONFIG_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Non-critical — best effort on platforms that support it
  }
}

// ==================== Runtime State ====================

let cachedModel: Model<Api> | null = null;
let cachedApiKey: string | null = null;
let activeConfig: PersistedConfig | null = null;

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
  const api = providerInfo?.api ?? 'openai-completions';
  let baseUrl = cfg.baseUrl ?? providerInfo?.defaultBaseUrl ?? '';

  // Azure-specific: append /openai to endpoint
  if (cfg.provider === 'azure-openai' && !cfg.baseUrl) {
    const endpoint = process.env.AZURE_OPENAI_API_ENDPOINT ?? '';
    baseUrl = endpoint.replace(/\/+$/, '') + '/openai';
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

  // For Copilot, apply pi-ai's model overrides (baseUrl from token, headers)
  if (cfg.provider === 'github-copilot') {
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
    // Check persisted config
    const persisted = loadPersistedConfig();
    if (persisted?.provider === 'azure-openai') {
      return [
        {
          id: persisted.model,
          name: `Azure: ${persisted.model}`,
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
    };
  } catch (err) {
    console.warn(
      'Failed to load LLM config:',
      err instanceof Error ? err.message : err,
    );
    return {
      provider: '',
      model: '',
      authenticated: false,
    };
  }
}

/**
 * Update the active LLM provider/model configuration.
 * Clears cached model so the next call uses the new config.
 *
 * Returns an authoritative `authenticated` flag for OAuth providers —
 * see {@link getLLMConfig} for the rationale.
 */
export async function setLLMConfig(
  update: LLMConfigUpdate,
): Promise<LLMConfig> {
  const persisted: PersistedConfig = {
    provider: update.provider,
    model: update.model,
    ...(update.apiKey ? { apiKey: update.apiKey } : {}),
    ...(update.baseUrl ? { baseUrl: update.baseUrl } : {}),
  };

  // Merge with existing persisted apiKey if not provided in this update
  if (!update.apiKey) {
    const existing = loadPersistedConfig();
    if (existing?.provider === update.provider && existing.apiKey) {
      persisted.apiKey = existing.apiKey;
    }
  }

  savePersistedConfig(persisted);
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
  };
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

/**
 * Stream LLM responses with the active model.
 */
export async function llmStream(
  context: Context,
  options?: ProviderStreamOptions,
) {
  const model = getLLMModel();
  const apiKey = await ensureApiKey();
  return piStream(model, context, {
    apiKey,
    ...options,
  });
}

/**
 * Complete (non-streaming) LLM call with the active model.
 */
export async function llmComplete(
  context: Context,
  options?: ProviderStreamOptions,
) {
  const model = getLLMModel();
  const apiKey = await ensureApiKey();
  return piComplete(model, context, {
    apiKey,
    ...options,
  });
}
