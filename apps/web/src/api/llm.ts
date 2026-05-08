import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  LLMConfig,
  LLMConfigUpdate,
  LLMModelInfo,
  LLMModelsResponse,
  LLMProviderInfo,
  LLMProvidersResponse,
  OAuthDeviceCodeResponse,
  OAuthPollResponse,
  OAuthStatusResponse,
} from '@sediment/shared';

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

// ==================== OAuth ====================

/** Start a GitHub device code OAuth flow. */
export async function startOAuthLogin(): Promise<OAuthDeviceCodeResponse> {
  return apiFetch<OAuthDeviceCodeResponse>(routes.llmOAuthDeviceCode, {
    method: 'POST',
    fallbackMessage: 'Failed to start OAuth flow',
  });
}

/** Poll the OAuth device code flow for completion. */
export async function pollOAuthLogin(): Promise<OAuthPollResponse> {
  return apiFetch<OAuthPollResponse>(routes.llmOAuthPoll, {
    method: 'POST',
    fallbackMessage: 'Failed to poll OAuth',
  });
}

/** Get the current OAuth authentication status. */
export async function getOAuthStatus(): Promise<OAuthStatusResponse> {
  return apiFetch<OAuthStatusResponse>(routes.llmOAuthStatus, {
    fallbackMessage: 'Failed to get OAuth status',
  });
}

/** Logout from the OAuth provider. */
export async function logoutOAuth(): Promise<void> {
  await apiFetch<void>(routes.llmOAuthLogout, {
    method: 'POST',
    fallbackMessage: 'Failed to logout',
    raw: true,
  });
}
