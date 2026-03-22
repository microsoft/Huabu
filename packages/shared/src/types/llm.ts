/**
 * LLM Provider & Model Configuration Types
 *
 * Shared types for dynamic provider/model switching between web and server.
 */

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
}

/**
 * Payload for updating the LLM configuration.
 */
export interface LLMConfigUpdate {
  provider: string;
  model: string;
  /** API key — only sent when setting a new key; never returned by GET. */
  apiKey?: string;
  /** Optional base URL override. */
  baseUrl?: string;
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
