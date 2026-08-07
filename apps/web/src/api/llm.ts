// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  ChatThreadSettings,
  LLMConfig,
  LLMConfigUpdate,
  LLMImageConfig,
  LLMImageConfigUpdate,
  LLMModelInfo,
  LLMModelsResponse,
  LLMProviderInfo,
  LLMProvidersResponse,
  LLMUtilityConfig,
  LLMUtilityConfigUpdate,
  OAuthDeviceCodeResponse,
  OAuthPollResponse,
  OAuthStatusResponse,
  SetChatThreadSettingResponse,
} from '@huabu/shared';

// ==================== Config ====================

/** Fetch the current LLM provider/model configuration. */
export async function getLLMConfig(): Promise<LLMConfig> {
  return apiFetch<LLMConfig>(routes.llmConfig, {
    fallbackMessage: 'Failed to get LLM config',
  });
}

/** Update the LLM provider/model configuration. */
export async function putLLMConfig(
  update: LLMConfigUpdate,
): Promise<LLMConfig> {
  return apiFetch<LLMConfig>(routes.llmConfig, {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to update LLM config',
  });
}

/** Fetch the current image-generation configuration. */
export async function getLLMImageConfig(): Promise<LLMImageConfig> {
  return apiFetch<LLMImageConfig>(routes.llmImageConfig, {
    fallbackMessage: 'Failed to get image config',
  });
}

/** Update the image-generation configuration. */
export async function putLLMImageConfig(
  update: LLMImageConfigUpdate,
): Promise<LLMImageConfig> {
  return apiFetch<LLMImageConfig>(routes.llmImageConfig, {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to update image config',
  });
}

/** Fetch the current utility-tier model configuration. */
export async function getLLMUtilityConfig(): Promise<LLMUtilityConfig> {
  return apiFetch<LLMUtilityConfig>(routes.llmUtilityConfig, {
    fallbackMessage: 'Failed to get utility config',
  });
}

/** Update the utility-tier model configuration. */
export async function putLLMUtilityConfig(
  update: LLMUtilityConfigUpdate,
): Promise<LLMUtilityConfig> {
  return apiFetch<LLMUtilityConfig>(routes.llmUtilityConfig, {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to update utility config',
  });
}

// ==================== Providers ====================

/** Fetch the list of available LLM providers. */
export async function getLLMProviders(): Promise<LLMProviderInfo[]> {
  const data = await apiFetch<LLMProvidersResponse>(routes.llmProviders, {
    fallbackMessage: 'Failed to get LLM providers',
  });
  return data.providers;
}

// ==================== Models ====================

/** Fetch the available models for a given provider. */
export async function getLLMModels(provider: string): Promise<LLMModelInfo[]> {
  const data = await apiFetch<LLMModelsResponse>(routes.llmModels(provider), {
    fallbackMessage: 'Failed to get LLM models',
  });
  return data.models;
}

// ==================== Per-thread chat settings (built-in agent) ==========

/** Read a built-in chat thread's per-thread model / reasoning-effort selection. */
export async function getChatThreadSettings(
  threadId: string,
  canvasId?: string,
): Promise<ChatThreadSettings> {
  return apiFetch<ChatThreadSettings>(
    routes.agentThreadSettings(threadId, canvasId),
    { fallbackMessage: 'Failed to load chat settings' },
  );
}

/** Set a built-in chat thread's per-thread model override. Returns the
 * resulting settings — switching model may drop/clamp an incompatible
 * reasoning effort server-side. */
export async function setChatThreadModel(
  threadId: string,
  modelId: string,
  canvasId?: string,
): Promise<ChatThreadSettings> {
  return apiFetch<ChatThreadSettings>(routes.agentThreadModel(threadId), {
    method: 'POST',
    json: { modelId, canvasId },
    fallbackMessage: 'Failed to switch model',
  });
}

/** Set a built-in chat thread's per-thread reasoning effort. */
export async function setChatThreadReasoningEffort(
  threadId: string,
  reasoningEffort: string,
  canvasId?: string,
): Promise<SetChatThreadSettingResponse> {
  return apiFetch<SetChatThreadSettingResponse>(
    routes.agentThreadReasoningEffort(threadId),
    {
      method: 'POST',
      json: { reasoningEffort, canvasId },
      fallbackMessage: 'Failed to set reasoning effort',
    },
  );
}

// ==================== OAuth ====================

/** Start a device-code OAuth flow for a provider (defaults to Copilot). */
export async function startOAuthLogin(
  provider?: string,
): Promise<OAuthDeviceCodeResponse> {
  return apiFetch<OAuthDeviceCodeResponse>(routes.llmOAuthDeviceCode, {
    method: 'POST',
    json: provider ? { provider } : {},
    fallbackMessage: 'Failed to start OAuth flow',
  });
}

/** Poll the OAuth device code flow for completion. */
export async function pollOAuthLogin(
  provider?: string,
): Promise<OAuthPollResponse> {
  return apiFetch<OAuthPollResponse>(routes.llmOAuthPoll, {
    method: 'POST',
    json: provider ? { provider } : {},
    fallbackMessage: 'Failed to poll OAuth',
  });
}

/** Get the current OAuth authentication status for a provider. */
export async function getOAuthStatus(
  provider = 'github-copilot',
): Promise<OAuthStatusResponse> {
  const url = `${routes.llmOAuthStatus}?provider=${encodeURIComponent(provider)}`;
  return apiFetch<OAuthStatusResponse>(url, {
    fallbackMessage: 'Failed to get OAuth status',
  });
}

/** Logout from a provider's OAuth session (defaults to Copilot). */
export async function logoutOAuth(provider?: string): Promise<void> {
  await apiFetch<void>(routes.llmOAuthLogout, {
    method: 'POST',
    json: provider ? { provider } : {},
    fallbackMessage: 'Failed to logout',
    raw: true,
  });
}
