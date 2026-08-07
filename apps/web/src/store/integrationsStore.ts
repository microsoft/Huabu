// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import {
  getIntegrationsConfig,
  putIntegrationsConfig,
} from '../api/integrations';

import type {
  IntegrationsConfig,
  IntegrationsConfigUpdate,
} from '@huabu/shared';

interface IntegrationsState {
  /** Masked config (booleans only) from the server. */
  config: IntegrationsConfig | null;
  /** Whether the config is being loaded. */
  loading: boolean;
  /** Whether an update is in progress. */
  saving: boolean;
  /** Last error message. */
  error: string | null;

  /** Load the current masked config from the server. */
  init: () => Promise<void>;
  /** Set API keys or remove them explicitly with null. */
  updateConfig: (update: IntegrationsConfigUpdate) => Promise<void>;
}

export const useIntegrationsStore = create<IntegrationsState>()((set, get) => ({
  config: null,
  loading: false,
  saving: false,
  error: null,

  init: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const config = await getIntegrationsConfig();
      set({ config, loading: false });
    } catch (err) {
      set({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to load integrations config',
        loading: false,
      });
    }
  },

  updateConfig: async (update) => {
    set({ saving: true, error: null });
    try {
      const config = await putIntegrationsConfig(update);
      set({ config, saving: false });
    } catch (err) {
      set({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to update integrations config',
        saving: false,
      });
    }
  },
}));
