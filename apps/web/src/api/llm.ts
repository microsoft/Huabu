import { API_CONFIG } from '../config/api';

import type {
  LLMConfig,
  LLMModelInfo,
  LLMModelsResponse,
  LLMProviderInfo,
  OAuthDeviceCodeResponse,
  OAuthPollResponse,
  OAuthStatusResponse,
} from '@sediment/shared';

// ==================== Config ====================

/** Fetch the current LLM provider/model configuration. */
export async function getLLMConfig(): Promise<LLMConfig> {
  const response = await fetch(`${API_CONFIG.API_URL}/llm/config`);
  if (!response.ok) {
    throw new Error(`Failed to get LLM config: ${response.statusText}`);
  }
  return (await response.json()) as LLMConfig;
}

/** Update the LLM provider/model configuration. */
export async function putLLMConfig(update: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<LLMConfig> {
  const response = await fetch(`${API_CONFIG.API_URL}/llm/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      err.message ?? `Failed to update LLM config: ${response.statusText}`,
    );
  }
  return (await response.json()) as LLMConfig;
}

// ==================== Providers ====================

/** Fetch the list of available LLM providers. */
export async function getLLMProviders(): Promise<LLMProviderInfo[]> {
  const response = await fetch(`${API_CONFIG.API_URL}/llm/providers`);
  if (!response.ok) {
    throw new Error(`Failed to get LLM providers: ${response.statusText}`);
  }
  const data = (await response.json()) as { providers: LLMProviderInfo[] };
  return data.providers;
}

// ==================== Models ====================

/** Fetch the available models for a given provider. */
export async function getLLMModels(provider: string): Promise<LLMModelInfo[]> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/llm/models?provider=${encodeURIComponent(provider)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to get LLM models: ${response.statusText}`);
  }
  const data = (await response.json()) as LLMModelsResponse;
  return data.models;
}

// ==================== OAuth ====================

/** Start a GitHub device code OAuth flow. */
export async function startOAuthLogin(): Promise<OAuthDeviceCodeResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/llm/oauth/device-code`, {
    method: 'POST',
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      err.message ?? `Failed to start OAuth flow: ${response.statusText}`,
    );
  }
  return (await response.json()) as OAuthDeviceCodeResponse;
}

/** Poll the OAuth device code flow for completion. */
export async function pollOAuthLogin(): Promise<OAuthPollResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/llm/oauth/poll`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Failed to poll OAuth: ${response.statusText}`);
  }
  return (await response.json()) as OAuthPollResponse;
}

/** Get the current OAuth authentication status. */
export async function getOAuthStatus(): Promise<OAuthStatusResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/llm/oauth/status`);
  if (!response.ok) {
    throw new Error(`Failed to get OAuth status: ${response.statusText}`);
  }
  return (await response.json()) as OAuthStatusResponse;
}

/** Logout from the OAuth provider. */
export async function logoutOAuth(): Promise<void> {
  const response = await fetch(`${API_CONFIG.API_URL}/llm/oauth/logout`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Failed to logout: ${response.statusText}`);
  }
}
