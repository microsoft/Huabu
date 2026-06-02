/**
 * `useAcpAgentsStore` — Singleton Zustand store for the connected-ACP-
 * agents list (the data behind `useAcpAgents`).
 *
 * Why a store and not per-component state? Previously each consumer of
 * `useAcpAgents` (ChatPanel, QuestionNode, etc.) owned its own copy of
 * the list. That worked when refreshes were always user-initiated
 * inside the same component, but it makes cross-component triggers
 * impossible: when the Settings popover detects that a freshly paired
 * agent just came online, it needs ChatPanel's copy of the agents
 * list to be refreshed BEFORE flipping `agentBinding` to that agent —
 * otherwise ChatPanel's stale-binding auto-reset effect would
 * immediately revert it (the agent isn't in *its* `connectedAgents`
 * yet, so the effect concludes the binding is dangling and resets to
 * internal).
 *
 * Centralising the list in a store solves that ordering problem: any
 * caller can `await useAcpAgentsStore.getState().refresh()` and be
 * sure every subscriber sees the new data on the next render.
 *
 * The `useAcpAgents` hook remains the public API — it now becomes a
 * thin wrapper that subscribes to this store and triggers the
 * once-only initial fetch.
 */

import { create } from 'zustand';

import { listAcpAgents } from '@/api/acp';

import type { AcpAgentSummary } from '@/api/acp';

interface AcpAgentsState {
  /** Currently-connected agents. Empty array until the first fetch resolves. */
  agents: AcpAgentSummary[];
  /** `true` once the initial fetch has resolved at least once. */
  loaded: boolean;
  /** Last error from a fetch, or `null`. Cleared on the next successful fetch. */
  error: Error | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /**
   * Internal flag: whether the initial fetch has been *started* (not
   * necessarily completed). Used by {@link init} to dedupe the
   * once-per-app first fetch across multiple `useAcpAgents` consumers
   * mounting in parallel.
   */
  initStarted: boolean;
  /**
   * Idempotent first-load helper called by the hook on mount. Skips
   * if a fetch has already started.
   */
  init: () => Promise<void>;
  /** Force a fresh GET. Safe to call concurrently. */
  refresh: () => Promise<void>;
}

export const useAcpAgentsStore = create<AcpAgentsState>()((set, get) => ({
  agents: [],
  loaded: false,
  error: null,
  loading: false,
  initStarted: false,
  init: async () => {
    if (get().initStarted) return;
    set({ initStarted: true });
    await get().refresh();
  },
  refresh: async () => {
    set({ loading: true });
    try {
      const res = await listAcpAgents();
      set({ agents: res.agents, loaded: true, error: null, loading: false });
    } catch (err) {
      // Leave `agents` and `loaded` untouched so transient errors
      // don't make the indicator flicker.
      set({
        error: err instanceof Error ? err : new Error(String(err)),
        loading: false,
      });
    }
  },
}));
