import { create } from 'zustand';

import {
  getLLMConfig,
  getLLMImageConfig,
  getLLMModels,
  getLLMProviders,
  logoutOAuth,
  pollOAuthLogin,
  putLLMConfig,
  putLLMImageConfig,
  startOAuthLogin,
} from '../api/llm';

import type {
  LLMConfig,
  LLMConfigUpdate,
  LLMImageConfig,
  LLMImageConfigUpdate,
  LLMModelInfo,
  LLMProviderInfo,
} from '@sediment/shared';

interface LLMState {
  /** Current LLM configuration from the server. */
  config: LLMConfig | null;
  /** Current image-generation configuration from the server. */
  imageConfig: LLMImageConfig | null;
  /** Available providers. */
  providers: LLMProviderInfo[];
  /** Models for the currently selected provider. */
  models: LLMModelInfo[];
  /** Whether data is being loaded. */
  loading: boolean;
  /** Whether a config update is in progress. */
  saving: boolean;
  /** Whether an image-config update is in progress. */
  imageSaving: boolean;
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
  /** Update provider/model (and optionally API key). */
  updateConfig: (update: LLMConfigUpdate) => Promise<void>;
  /** Update image-generation provider config. */
  updateImageConfig: (update: LLMImageConfigUpdate) => Promise<void>;
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
  providers: [],
  models: [],
  loading: false,
  saving: false,
  imageSaving: false,
  error: null,
  oauthPending: false,
  oauthUserCode: null,
  oauthVerificationUri: null,

  init: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const [config, imageConfig, providers] = await Promise.all([
        getLLMConfig(),
        getLLMImageConfig(),
        getLLMProviders(),
      ]);
      set({ config, imageConfig, providers, loading: false });

      // Pre-load models for the active provider
      if (config.provider) {
        const models = await getLLMModels(config.provider);
        set({ models });
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

  startOAuth: async () => {
    set({
      oauthPending: true,
      error: null,
      oauthUserCode: null,
      oauthVerificationUri: null,
    });
    try {
      const { userCode, verificationUri, interval } = await startOAuthLogin();
      set({ oauthUserCode: userCode, oauthVerificationUri: verificationUri });

      // Open the verification URL in a new tab
      window.open(verificationUri, '_blank', 'noopener');

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
          const result = await pollOAuthLogin();
          if (result.status === 'complete') {
            set({
              oauthPending: false,
              oauthUserCode: null,
              oauthVerificationUri: null,
            });
            // Refresh config to reflect authenticated state
            const config = await getLLMConfig();
            set({ config });
            return;
          }
          if (result.status === 'expired' || result.status === 'error') {
            set({
              oauthPending: false,
              oauthUserCode: null,
              oauthVerificationUri: null,
              error: result.error ?? 'OAuth flow expired. Please try again.',
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
    set({ error: null });
    try {
      await logoutOAuth();
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
