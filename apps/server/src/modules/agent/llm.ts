/**
 * LLM Configuration — pi-ai based, multi-provider
 *
 * Supports dynamic provider/model switching at runtime.
 * Configuration is persisted to data/llm-config.json and can be
 * changed via the /api/llm routes.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  stream as piStream,
  complete as piComplete,
  getModel,
  getModels,
} from '@mariozechner/pi-ai';

import {
  getCopilotApiKey,
  hasOAuthCredentials,
  applyCopilotModelOverrides,
} from './oauth.js';

import type {
  Api,
  Context,
  KnownProvider,
  Model,
  ProviderStreamOptions,
} from '@mariozechner/pi-ai';
import type {
  LLMConfig,
  LLMConfigUpdate,
  LLMModelInfo,
  LLMProviderInfo,
} from '@sediment/shared';

// ==================== Provider Catalog ====================

const PROVIDER_CATALOG: LLMProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    envKey: 'ANTHROPIC_API_KEY',
    builtIn: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-completions',
    envKey: 'OPENAI_API_KEY',
    builtIn: true,
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    api: 'azure-openai-responses',
    envKey: 'AZURE_OPENAI_API_KEY',
    builtIn: false, // Azure models are custom deployments
  },
  {
    id: 'google',
    name: 'Google Gemini',
    api: 'google-generative-ai',
    envKey: 'GEMINI_API_KEY',
    builtIn: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    api: 'openai-completions',
    envKey: 'OPENROUTER_API_KEY',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    builtIn: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    api: 'openai-completions',
    envKey: 'GROQ_API_KEY',
    builtIn: true,
  },
  {
    id: 'xai',
    name: 'xAI',
    api: 'openai-completions',
    envKey: 'XAI_API_KEY',
    builtIn: true,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    api: 'openai-completions',
    envKey: 'MISTRAL_API_KEY',
    builtIn: true,
  },
  {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    api: 'bedrock-converse-stream',
    envKey: 'AWS_ACCESS_KEY_ID',
    builtIn: true,
  },
  {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    api: 'google-vertex',
    envKey: 'GOOGLE_CLOUD_API_KEY',
    builtIn: true,
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    api: 'openai-completions',
    envKey: 'COPILOT_GITHUB_TOKEN',
    defaultBaseUrl: 'https://api.githubcopilot.com',
    builtIn: true,
    authType: 'oauth',
  },
];

// ==================== Persisted Config ====================

const CONFIG_FILE = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '..',
  '..',
  '..',
  '..',
  'data',
  'llm-config.json',
);

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
}

// ==================== Runtime State ====================

let cachedModel: Model<Api> | null = null;
let cachedApiKey: string | null = null;
let activeConfig: PersistedConfig | null = null;

/** Resolve the API key for a provider from env vars, persisted config, or explicit value. */
function resolveApiKey(
  providerId: string,
  explicitKey?: string,
): string | null {
  if (explicitKey) return explicitKey;

  // Check persisted config
  const persisted = loadPersistedConfig();
  if (persisted?.provider === providerId && persisted.apiKey) {
    return persisted.apiKey;
  }

  // Fall back to environment variables
  const providerInfo = PROVIDER_CATALOG.find((p) => p.id === providerId);
  if (providerInfo) {
    const val = process.env[providerInfo.envKey];
    if (val) return val;
  }

  // Provider-specific env var aliases
  if (providerId === 'azure-openai') {
    return process.env.AZURE_OPENAI_API_KEY ?? null;
  }

  return null;
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
  const providerInfo = PROVIDER_CATALOG.find((p) => p.id === cfg.provider);

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
  for (const p of PROVIDER_CATALOG) {
    if (p.builtIn && process.env[p.envKey]) {
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
  return PROVIDER_CATALOG;
}

/**
 * Get available models for a given provider.
 */
export function getModelsForProvider(providerId: string): LLMModelInfo[] {
  const providerInfo = PROVIDER_CATALOG.find((p) => p.id === providerId);
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
 */
export function getLLMConfig(): LLMConfig {
  try {
    const cfg = ensureConfig();
    const providerInfo = PROVIDER_CATALOG.find((p) => p.id === cfg.provider);
    const isOAuth = providerInfo?.authType === 'oauth';

    // For OAuth providers, check OAuth credentials
    const authenticated = isOAuth
      ? hasOAuthCredentials(cfg.provider)
      : !!resolveApiKey(cfg.provider);

    return {
      provider: cfg.provider,
      model: cfg.model,
      authenticated,
      baseUrl: cfg.baseUrl,
    };
  } catch {
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
 */
export function setLLMConfig(update: LLMConfigUpdate): LLMConfig {
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

  const providerInfo = PROVIDER_CATALOG.find(
    (p) => p.id === persisted.provider,
  );
  const isOAuth = providerInfo?.authType === 'oauth';
  const authenticated = isOAuth
    ? hasOAuthCredentials(persisted.provider)
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
    const providerInfo = PROVIDER_CATALOG.find((p) => p.id === cfg.provider);
    if (providerInfo?.authType !== 'oauth') {
      throw new Error(
        `API key not found for provider "${cfg.provider}". ` +
          `Set ${providerInfo?.envKey ?? 'the API key'} in .env or configure via Settings.`,
      );
    }
  }

  cachedModel = buildModel(cfg);
  return cachedModel;
}

/**
 * Ensure we have a valid API key, refreshing OAuth tokens if needed.
 */
async function ensureApiKey(): Promise<string> {
  const cfg = ensureConfig();
  const key = await resolveApiKeyAsync(cfg.provider, cfg.apiKey);
  if (!key) {
    const providerInfo = PROVIDER_CATALOG.find((p) => p.id === cfg.provider);
    throw new Error(
      `Authentication failed for provider "${cfg.provider}". ` +
        (providerInfo?.authType === 'oauth'
          ? 'Please log in via Settings.'
          : `Set ${providerInfo?.envKey ?? 'the API key'} in .env or configure via Settings.`),
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
