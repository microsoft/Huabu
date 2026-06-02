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
  /** Currently-connected agents. Empty array until the first successful fetch. */
  agents: AcpAgentSummary[];
  /**
   * `true` once a fetch has *succeeded* at least once. A failed
   * initial fetch leaves this `false` (and {@link agents} empty), so
   * consumers can use `loaded` to distinguish "no agents connected"
   * from "we don't know yet / the last attempt errored" — check
   * {@link error} alongside it for the failure case.
   */
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
    // Refresh the connected-agents list every time the user comes
    // back to the tab. Why here instead of inside the `useAcpAgents`
    // hook? Each hook consumer (ChatPanel, QuestionNode, etc.) would
    // otherwise install its own listener and we'd fire N refreshes
    // per visibility flip. Installing once inside the singleton store's
    // `init` (already deduped by `initStarted`) gives us exactly one
    // listener for the app's lifetime, and `get().refresh()` always
    // dispatches against the same singleton.
    //
    // Cost: one cheap GET per "tab became visible" — no polling, no
    // work while hidden. The route is an in-memory map walk so the
    // server hit is negligible. The listener is intentionally never
    // removed: the store is a process singleton, so it should live as
    // long as the app does.
    //
    // Why visibilitychange instead of `focus`? `focus` fires for
    // anything that takes focus from the page (devtools open, address
    // bar click, alt-tab inside the same window), which is noisier
    // without giving us a better signal — the badge only matters when
    // the user is actually looking at the chat surface.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void get().refresh();
        }
      });
    }
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
