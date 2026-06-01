/**
 * Front-end mirror of `/api/acp/config` — the ACP bridge enable flag
 * and shared `agentlet` token.
 *
 * Shape mirrors {@link useLLMStore}: lazy `init` triggered when the
 * Settings popover opens, `saving` flag for inflight PUTs, simple
 * error surfacing.
 *
 * The store also re-loads the ACP agents list on every successful
 * write so the ChatPanel agent picker reflects the enable-flag change
 * without a full reload. Re-load is fire-and-forget; failures are
 * absorbed because the picker has its own polling loop as a fallback.
 */

import { create } from 'zustand';

import { getAcpConfig, updateAcpConfig } from '../api/acp';

import type { AcpConfig, AcpConfigUpdate } from '@sediment/shared';

interface AcpConfigState {
  /** Current persisted config from the server. */
  config: AcpConfig | null;
  /** Whether `init` is in flight. */
  loading: boolean;
  /** Whether a `setConfig` write is in flight. */
  saving: boolean;
  /** Last error from any of the calls. */
  error: string | null;

  /** Load the config from the server (idempotent; skipped if already loading). */
  init: () => Promise<void>;
  /** Re-read the config — useful after a server-side change. */
  refresh: () => Promise<void>;
  /** Persist a new config to the server and update local state. */
  setConfig: (update: AcpConfigUpdate) => Promise<void>;
}

export const useAcpConfigStore = create<AcpConfigState>()((set, get) => ({
  config: null,
  loading: false,
  saving: false,
  error: null,

  init: async () => {
    if (get().loading || get().config) return;
    set({ loading: true, error: null });
    try {
      const config = await getAcpConfig();
      set({ config, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load ACP config',
        loading: false,
      });
    }
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const config = await getAcpConfig();
      set({ config, loading: false });
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : 'Failed to refresh ACP config',
        loading: false,
      });
    }
  },

  setConfig: async (update) => {
    set({ saving: true, error: null });
    try {
      const config = await updateAcpConfig(update);
      set({ config, saving: false });
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : 'Failed to update ACP config',
        saving: false,
      });
    }
  },
}));
