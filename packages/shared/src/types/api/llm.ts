/**
 * LLM Provider & Model Configuration Types
 *
 * Shared types & schemas for dynamic provider/model switching between
 * web and server. Per docs/api-design.md: schemas are the single source
 * of truth, types derived via `z.infer`.
 */

import { z } from 'zod';

// ==================== Provider Registry ====================

/**
 * API protocol identifier used by pi-ai (e.g. "openai-completions", "anthropic-messages").
 * Accepts any string to allow new APIs added in future pi-ai versions.
 */
export type LLMApiType = string;

/**
 * A provider entry in the provider catalog.
 */
export interface LLMProviderInfo {
  /** Unique provider identifier (e.g. "anthropic", "openai"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Default API protocol for models on this provider. */
  api: LLMApiType;
  /** Default base URL (can be overridden at runtime). */
  defaultBaseUrl?: string;
  /** Whether this provider uses built-in pi-ai models. */
  builtIn: boolean;
  /** Authentication type: 'api-key' (default) or 'oauth'. */
  authType?: 'api-key' | 'oauth';
}

/**
 * A model entry exposed to the frontend.
 */
export interface LLMModelInfo {
  /** Model identifier passed to the API. */
  id: string;
  /** Human-readable model name. */
  name: string;
  /** Provider this model belongs to. */
  provider: string;
  /** Whether this model supports extended thinking / reasoning. */
  reasoning: boolean;
  /** Supported input types. */
  input: ('text' | 'image')[];
}

// ==================== Active Configuration ====================

/**
 * The currently active LLM configuration, persisted on the server
 * and displayed/editable on the frontend.
 */
export interface LLMConfig {
  /** Active provider ID. */
  provider: string;
  /** Active model ID within the provider. */
  model: string;
  /** Whether the provider is authenticated (has valid API key). */
  authenticated: boolean;
  /** Optional custom base URL override. */
  baseUrl?: string;
  apiVersion?: string;
  /**
   * Azure-only: deployment name for image generation
   * (gpt-image-1 family). Separate from {@link model} because Azure
   * customers typically deploy chat and image models under the same
   * resource (sharing `baseUrl` / `apiKey` / `apiVersion`) but at
   * different deployment names. Empty / undefined means "image
   * generation not configured" and the `generate_image` agent tool
   * will return a clean error.
   */
  imageModel?: string;
  /**
   * Default rendering quality for {@link imageModel}. Each step up
   * roughly multiplies cost and latency, so we default to `'low'`.
   * The agent's `generate_image` tool can override per call.
   */
  imageQuality?: 'low' | 'medium' | 'high' | 'auto';
}

/**
 * Body for `PUT /api/llm/config`.
 */
export const llmConfigUpdateSchema = z.object({
  provider: z.string().min(1, 'Provider is required'),
  model: z.string(),
  /** API key — only sent when setting a new key; never returned by GET. */
  apiKey: z.string().optional(),
  /** Optional base URL override. */
  baseUrl: z.string().optional(),
  apiVersion: z.string().optional(),
  /**
   * Azure-only image-generation deployment name. Same omission
   * semantics as the other optional fields: omitted (undefined) keeps
   * the previously-saved value, empty string clears it.
   */
  imageModel: z.string().optional(),
  /**
   * Default rendering quality for image generation. Same omission
   * semantics as the other optional fields. Server treats an absent
   * value as `'low'`.
   */
  imageQuality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
});
export type LLMConfigUpdate = z.infer<typeof llmConfigUpdateSchema>;

/** Querystring for `GET /api/llm/models`. */
export const llmModelsQuerySchema = z.object({
  provider: z.string().min(1, 'Provider query param is required'),
});
export type LLMModelsQuery = z.infer<typeof llmModelsQuerySchema>;

/** Querystring for `GET /api/llm/oauth/status`. */
export const oauthStatusQuerySchema = z.object({
  provider: z.string().min(1),
});
export type OAuthStatusQuery = z.infer<typeof oauthStatusQuerySchema>;

/**
 * Response from GET /api/llm/providers
 */
export interface LLMProvidersResponse {
  providers: LLMProviderInfo[];
}

/**
 * Response from GET /api/llm/models?provider=xxx
 */
export interface LLMModelsResponse {
  provider: string;
  models: LLMModelInfo[];
}

// ==================== OAuth ====================

/**
 * Response from POST /api/llm/oauth/device-code
 */
export interface OAuthDeviceCodeResponse {
  /** The user code to display to the user. */
  userCode: string;
  /** The URL the user should visit to enter the code. */
  verificationUri: string;
  /** Seconds between poll attempts. */
  interval: number;
}

/**
 * Response from POST /api/llm/oauth/poll
 */
export interface OAuthPollResponse {
  /** Whether the user has completed authorization. */
  status: 'pending' | 'complete' | 'expired' | 'error';
  /** Error message if status is 'error'. */
  error?: string;
}

/**
 * Response from GET /api/llm/oauth/status
 */
export interface OAuthStatusResponse {
  /** Whether we have valid OAuth credentials for the provider. */
  authenticated: boolean;
  /** Provider the OAuth session is for. */
  provider: string;
}
