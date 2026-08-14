// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import {
  getLLMConfig,
  getLLMImageConfig,
  getLLMModels,
  getLLMProviders,
  getLLMUtilityConfig,
  logoutOAuth,
  pollOAuthLogin,
  putLLMConfig,
  putLLMImageConfig,
  putLLMUtilityConfig,
  startOAuthLogin,
} from '../api/llm';

import type {
  LLMConfig,
  LLMConfigUpdate,
  LLMImageConfig,
  LLMImageConfigUpdate,
  LLMModelInfo,
  LLMProviderInfo,
  LLMUtilityConfig,
  LLMUtilityConfigUpdate,
} from '@huabu/shared';

/**
 * Collapse a noisy provider error into a single readable line.
 *
 * GitHub's device-code token exchange can transiently fail with a 502 whose
 * body is a full HTML error page ("Unicorn!"). Surfacing that raw blob in a
 * toast is unreadable, so keep only the leading status text (everything
 * before the first HTML tag) and cap the length.
 */
function summarizeOAuthError(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const beforeHtml = raw.split('<')[0].trim();
  const concise = beforeHtml || raw.trim();
  return concise.length > 200 ? `${concise.slice(0, 200)}…` : concise;
}

interface LLMState {
  /** Current LLM configuration from the server. */
  config: LLMConfig | null;
  /** Current image-generation configuration from the server. */
  imageConfig: LLMImageConfig | null;
  /** Current utility-tier model configuration from the server. */
  utilityConfig: LLMUtilityConfig | null;
  /** Available providers. */
  providers: LLMProviderInfo[];
  /** Models for the currently selected provider. */
  models: LLMModelInfo[];
  /** Models for the currently selected utility provider. */
  utilityModels: LLMModelInfo[];
  /** Whether data is being loaded. */
  loading: boolean;
  /** Whether a config update is in progress. */
  saving: boolean;
  /** Whether an image-config update is in progress. */
  imageSaving: boolean;
  /** Whether a utility-config update is in progress. */
  utilitySaving: boolean;
  /** Last error message. */
  error: string | null;

  // ── OAuth state ──
  /** Whether an OAuth device code flow is in progress. */
  oauthPending: boolean;
  /** The user code to display during OAuth login. */
  oauthUserCode: string | null;
  /** The URL the user must visit to enter the code. */
  oauthVerificationUri: string | null;

  /** Load providers and current config from the server. */
  init: () => Promise<void>;
  /** Load models for a specific provider. */
  loadModels: (provider: string) => Promise<void>;
  /** Load models for the utility provider. */
  loadUtilityModels: (provider: string) => Promise<void>;
  /** Update provider/model (and optionally API key). */
  updateConfig: (update: LLMConfigUpdate) => Promise<void>;
  /** Update image-generation provider config. */
  updateImageConfig: (update: LLMImageConfigUpdate) => Promise<void>;
  /** Update utility-tier model config. */
  updateUtilityConfig: (update: LLMUtilityConfigUpdate) => Promise<void>;
  /** Start an OAuth device code login flow. */
  startOAuth: () => Promise<void>;
  /** Cancel an in-progress OAuth flow. */
  cancelOAuth: () => void;
  /** Logout from OAuth provider. */
  logoutOAuth: () => Promise<void>;
}

export const useLLMStore = create<LLMState>()((set, get) => ({
  config: null,
  imageConfig: null,
  utilityConfig: null,
  providers: [],
  models: [],
  utilityModels: [],
  loading: false,
  saving: false,
  imageSaving: false,
  utilitySaving: false,
  error: null,
  oauthPending: false,
  oauthUserCode: null,
  oauthVerificationUri: null,

  init: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const [config, imageConfig, utilityConfig, providers] = await Promise.all(
        [
          getLLMConfig(),
          getLLMImageConfig(),
          getLLMUtilityConfig(),
          getLLMProviders(),
        ],
      );
      set({ config, imageConfig, utilityConfig, providers, loading: false });

      // Pre-load models for the active provider
      if (config.provider) {
        const models = await getLLMModels(config.provider);
        set({ models });
      }
      // Pre-load models for the utility provider (when not following chat)
      if (utilityConfig.provider) {
        const utilityModels = await getLLMModels(utilityConfig.provider);
        set({ utilityModels });
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load LLM config',
        loading: false,
      });
    }
  },

  loadModels: async (provider: string) => {
    try {
      const models = await getLLMModels(provider);
      set({ models });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load models',
      });
    }
  },

  loadUtilityModels: async (provider: string) => {
    try {
      const utilityModels = await getLLMModels(provider);
      set({ utilityModels });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load models',
      });
    }
  },

  updateConfig: async (update) => {
    set({ saving: true, error: null });
    try {
      const config = await putLLMConfig(update);
      set({ config, saving: false });
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : 'Failed to update LLM config',
        saving: false,
      });
    }
  },

  updateImageConfig: async (update) => {
    set({ imageSaving: true, error: null });
    try {
      const imageConfig = await putLLMImageConfig(update);
      set({ imageConfig, imageSaving: false });
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : 'Failed to update image config',
        imageSaving: false,
      });
    }
  },

  updateUtilityConfig: async (update) => {
    set({ utilitySaving: true, error: null });
    try {
      const utilityConfig = await putLLMUtilityConfig(update);
      set({ utilityConfig, utilitySaving: false });
    } catch (err) {
      set({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to update utility config',
        utilitySaving: false,
      });
    }
  },

  startOAuth: async () => {
    // Log into whichever provider is currently active/selected (e.g.
    // github-copilot, openai-codex); the server defaults to Copilot if unset.
    const provider = get().config?.provider || undefined;
    set({
      oauthPending: true,
      error: null,
      oauthUserCode: null,
      oauthVerificationUri: null,
    });
    try {
      const { userCode, verificationUri, interval } =
        await startOAuthLogin(provider);
      set({ oauthUserCode: userCode, oauthVerificationUri: verificationUri });

      // Poll until user completes or flow expires
      const pollInterval = (interval || 5) * 1000;
      const maxPolls = 60; // ~5 minutes at 5s intervals
      let pollCount = 0;
      const poll = async () => {
        // Check if flow was cancelled or max polls exceeded
        if (!get().oauthPending) return;
        if (++pollCount > maxPolls) {
          set({
            oauthPending: false,
            oauthUserCode: null,
            oauthVerificationUri: null,
            error: 'OAuth flow timed out. Please try again.',
          });
          return;
        }

        try {
          const result = await pollOAuthLogin(provider);
          if (result.status === 'complete') {
            set({
              oauthPending: false,
              oauthUserCode: null,
              oauthVerificationUri: null,
            });
            // Refresh config to reflect authenticated state, then reload the
            // model list: OAuth providers (e.g. Copilot) expose an account-
            // specific entitlement that is only fetchable after login.
            const config = await getLLMConfig();
            set({ config });
            if (config.provider) await get().loadModels(config.provider);
            return;
          }
          if (result.status === 'expired' || result.status === 'error') {
            set({
              oauthPending: false,
              oauthUserCode: null,
              oauthVerificationUri: null,
              error:
                summarizeOAuthError(result.error) ??
                'OAuth flow expired. Please try again.',
            });
            return;
          }
          // Still pending — schedule next poll
          setTimeout(() => void poll(), pollInterval);
        } catch {
          set({
            oauthPending: false,
            oauthUserCode: null,
            oauthVerificationUri: null,
            error: 'OAuth polling failed.',
          });
        }
      };

      setTimeout(() => void poll(), pollInterval);
    } catch (err) {
      set({
        oauthPending: false,
        error:
          err instanceof Error ? err.message : 'Failed to start OAuth login',
      });
    }
  },

  cancelOAuth: () => {
    set({
      oauthPending: false,
      oauthUserCode: null,
      oauthVerificationUri: null,
    });
  },

  logoutOAuth: async () => {
    const provider = get().config?.provider || undefined;
    set({ error: null });
    try {
      await logoutOAuth(provider);
      // Refresh config to reflect unauthenticated state
      const config = await getLLMConfig();
      set({ config });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to logout',
      });
    }
  },
}));
