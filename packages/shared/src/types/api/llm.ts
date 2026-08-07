// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * LLM Provider & Model Configuration Types
 *
 * Shared types & schemas for dynamic provider/model switching between
 * web and server. Per docs/architecture/api-design.md: schemas are the single source
 * of truth, types derived via `z.infer`.
 */

import { z } from 'zod';

import { IMAGE_MODEL_FAMILIES } from '../../llm/image-capabilities.js';

import type { ImageModelFamily } from '../../llm/image-capabilities.js';

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
  /** Base URL capability and optional provider default. */
  baseUrl: {
    /** Endpoint used when the user has not configured an override. */
    default?: string;
    /** Whether Settings should allow a user-provided endpoint. */
    overridable: boolean;
  };
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
  /**
   * Per-token price in USD from pi-ai's registry, when known. Powers
   * cost-aware selection (e.g. the utility tier's cheapest-eligible
   * default) and price display in the model picker. Omitted for models
   * whose price the registry does not carry (custom endpoints, freshly
   * discovered ids).
   */
  cost?: { input: number; output: number };
  /**
   * Maximum context window in tokens from pi-ai's registry, when known.
   * Omitted for models the registry does not describe.
   */
  contextWindow?: number;
  /**
   * Supported reasoning-effort levels for this model (pi-ai thinking
   * levels, excluding `off`), e.g. `['low','medium','high']`. Omitted /
   * empty ⇒ the model has no reasoning-effort control. Powers the
   * per-thread reasoning-effort selector.
   */
  reasoningEfforts?: string[];
  /**
   * Supported service tiers for this model's API (only OpenAI-responses /
   * codex-responses / azure-responses expose the knob), e.g.
   * `['auto','flex','priority']`. Omitted / empty ⇒ no service-tier
   * control.
   */
  serviceTiers?: string[];
}

// ==================== Active Configuration ====================

/**
 * The currently active LLM configuration, persisted on the server
 * and displayed/editable on the frontend.
 *
 * **Chat-only fields.** Image generation lives in {@link LLMImageConfig}
 * and a separate endpoint pair, so users can pair (for example) a
 * GitHub Copilot chat model with an Azure image deployment without
 * either side overwriting the other's credentials.
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
}

/**
 * The image-generation configuration, persisted on the server and
 * displayed/editable on the frontend. Independent of {@link LLMConfig}
 * so chat and image can target different providers / endpoints /
 * keys.
 *
 * Today only `azure-openai` is supported; the `provider` field is
 * carried explicitly anyway so future image providers (OpenAI native,
 * Replicate, …) don't require a schema migration.
 */
export interface LLMImageConfig {
  /** Active image provider ID (e.g. `'azure-openai'`). Empty string when unconfigured. */
  provider: string;
  /** Whether the image provider has a saved API key. */
  authenticated: boolean;
  /** Optional custom base URL / endpoint. */
  baseUrl?: string;
  /** Azure deployment name configured by the user (free-form string). */
  model?: string;
  /**
   * Model family this deployment belongs to. Drives the per-family
   * capability lookup (legal sizes / qualities / default quality)
   * via {@link import('../../llm/image-capabilities.js').getImageCapabilities}.
   * Defaults to `'gpt-image-2'` server-side when unset.
   */
  modelFamily?: ImageModelFamily;
  /** Optional API version (Azure-only). */
  apiVersion?: string;
  /**
   * Default rendering quality. Each step up roughly multiplies cost
   * and latency. When unset, the server uses the family's
   * `defaultQuality` from the capability registry. The agent's
   * `generate_image` tool can override per call.
   */
  quality?: 'low' | 'medium' | 'high' | 'auto';
}

/**
 * Body for `PUT /api/llm/config`.
 */
export const llmConfigUpdateSchema = z.object({
  provider: z.string().min(1, 'Provider is required'),
  /** Optional patch field; omitted updates preserve the saved model. */
  model: z.string().optional(),
  /** API key — only sent when setting a new key; never returned by GET. */
  apiKey: z.string().optional(),
  /** Optional base URL override. */
  baseUrl: z.string().optional(),
  apiVersion: z.string().optional(),
});
export type LLMConfigUpdate = z.infer<typeof llmConfigUpdateSchema>;

/**
 * The utility-tier LLM configuration — the model used for lightweight
 * background roles (labeling, summaries, keywords). Its read shape is
 * **identical** to {@link LLMConfig}, so it is an alias, not a new
 * interface. An empty `provider` means "follow the chat model".
 */
export type LLMUtilityConfig = LLMConfig;

/**
 * Body for `PUT /api/llm/utility-config`. Reuses {@link llmConfigUpdateSchema}
 * but relaxes the one rule that differs: `provider` may be empty (`''`),
 * which the server interprets as "follow the chat model". The optional
 * `apiKey` is written back into the shared per-provider credential store
 * (v1.5 inline-key flow), so pointing utility at a not-yet-authenticated
 * provider does not require configuring it through the chat panel first.
 */
export const llmUtilityConfigUpdateSchema = llmConfigUpdateSchema.extend({
  provider: z.string(),
});
export type LLMUtilityConfigUpdate = z.infer<
  typeof llmUtilityConfigUpdateSchema
>;

/**
 * Body for `PUT /api/llm/image-config`. Every field is optional so a
 * single update can patch one field at a time (the UI auto-saves on
 * every keystroke). Omitting a field keeps the previously-saved value;
 * sending an empty string clears it.
 */
export const llmImageConfigUpdateSchema = z.object({
  provider: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  modelFamily: z
    .enum(
      IMAGE_MODEL_FAMILIES as unknown as [
        ImageModelFamily,
        ...ImageModelFamily[],
      ],
    )
    .optional(),
  apiVersion: z.string().optional(),
  /** API key — set with a string, remove with null; never returned by GET. */
  apiKey: z.string().min(1).nullable().optional(),
  quality: z.enum(['low', 'medium', 'high', 'auto']).optional(),
});
export type LLMImageConfigUpdate = z.infer<typeof llmImageConfigUpdateSchema>;

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
 * Body for `POST /api/llm/oauth/device-code`, `/oauth/poll`, and
 * `/oauth/logout`. `provider` is the OAuth provider id (e.g. `github-copilot`,
 * `openai-codex`); it defaults to `github-copilot` server-side when omitted.
 */
export const oauthProviderBodySchema = z.object({
  provider: z.string().trim().min(1).optional(),
});
export type OAuthProviderBody = z.infer<typeof oauthProviderBodySchema>;

// ==================== Per-thread chat settings ====================

/**
 * The built-in agent's per-thread capability selection, read from the
 * thread's durable driver state. `null` fields mean "use the global
 * Settings default". See docs/proposals/chat-session-capability-controls.md.
 */
export interface ChatThreadSettings {
  /** Per-thread model override id, or `null` to use the global default. */
  modelId: string | null;
  /** Per-thread reasoning effort (pi thinking level), or `null`. */
  reasoningEffort: string | null;
}

/** Response from `GET /api/agent/threads/:threadId/settings`. */
export type ChatThreadSettingsResponse = ChatThreadSettings;

/** Body for `POST /api/agent/threads/:threadId/model`. */
export const setChatThreadModelRequestSchema = z.object({
  canvasId: z.string().optional(),
  modelId: z.string().min(1),
});
export type SetChatThreadModelRequest = z.infer<
  typeof setChatThreadModelRequestSchema
>;

/**
 * Valid reasoning-effort values — pi-ai's thinking levels plus `off`
 * (the "Auto" / model-default choice). The authoritative set for both the
 * wire contract and per-model capability correction; non-UI callers cannot
 * persist an out-of-set value.
 */
export const REASONING_EFFORT_VALUES = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

/** Body for `POST /api/agent/threads/:threadId/reasoning-effort`. */
export const setChatThreadReasoningEffortRequestSchema = z.object({
  canvasId: z.string().optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES),
});
export type SetChatThreadReasoningEffortRequest = z.infer<
  typeof setChatThreadReasoningEffortRequestSchema
>;

/** Response from the per-thread chat-settings mutations. */
export interface SetChatThreadSettingResponse {
  ok: true;
}

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
