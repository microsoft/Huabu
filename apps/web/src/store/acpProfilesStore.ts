// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `useAcpProfilesStore` — Singleton Zustand store for the user's
 * external-agent profiles (the data behind {@link useAcpProfiles}).
 *
 * Why a store and not per-component state? Several surfaces need the
 * profile list in lockstep: the Settings editor lets the user CRUD
 * profiles, the chat picker uses the same list to label "external"
 * binding options, and ChatPanel's stale-binding auto-reset needs to
 * see the latest profiles BEFORE flipping a binding. Centralising
 * the list in a store means any caller can `await
 * useAcpProfilesStore.getState().refresh()` and be sure every
 * subscriber sees the new data on the next render.
 *
 * Shape change vs the legacy `useAcpAgentsStore`: this store holds
 * {@link AcpAgentProfile}[] (long-lived spawn recipes) instead of
 * `AcpAgentSummary[]` (volatile bridge connections that came and
 * went on pairing). The UI now treats "available" as "have a
 * profile" rather than "have a live connection" — the daemon spawns
 * the agent on first use.
 *
 * Daemon status is folded into the same response (the server returns
 * `{profiles, daemon}` on every `GET /api/acp/profiles`) so consumers
 * never have to coordinate two GETs and never see a torn view.
 *
 * Workspace-readiness retry: `/api/acp/profiles` is behind the server's
 * workspace-configured guard (everything outside `/api/workspace` and
 * `/api/llm` 503s until the user picks a workspace). The user can
 * legitimately open Settings on the WorkspaceSetupPage before picking
 * a folder; that first fetch will 503 and the error would otherwise
 * stick around forever (`initStarted` is one-shot). We listen for the
 * `workspace-changed` window event dispatched by `workspaceStore` and
 * silently re-fetch on transition, so the cached "Workspace has not
 * been configured" error doesn't replay as a toast next time Settings
 * mounts.
 */

import { create } from 'zustand';

import { listAcpProfiles } from '@/api/acp';

import type { AcpAgentletStatus, AgentProfileView } from '@/api/acp';

let inFlightRefresh: Promise<void> | null = null;

interface AcpProfilesState {
  /** Every profile the user has created. Empty until the first fetch. */
  profiles: AgentProfileView[];
  /** Profile ids that are currently runtime-ready and safe to select. */
  selectableProfileIds: string[];
  /** Latest agentlet snapshot. `null` until the first fetch resolves. */
  agentlet: AcpAgentletStatus | null;
  /**
   * `true` once a fetch has *succeeded* at least once. A failed initial
   * fetch leaves this `false` (and {@link profiles} empty), so consumers
   * can use `loaded` to distinguish "no profiles yet" from "we don't
   * know yet / the last attempt errored" — check {@link error} alongside
   * for the failure case.
   */
  loaded: boolean;
  /** Last error from a fetch, or `null`. Cleared on the next successful fetch. */
  error: Error | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /** Internal dedupe flag for the once-per-app initial fetch. */
  initStarted: boolean;
  /** Idempotent first-load helper called by the hook on mount. */
  init: () => Promise<void>;
  /** Force a fresh GET. Safe to call concurrently. */
  refresh: () => Promise<void>;
}

export const useAcpProfilesStore = create<AcpProfilesState>()((set, get) => ({
  profiles: [],
  selectableProfileIds: [],
  agentlet: null,
  loaded: false,
  error: null,
  loading: false,
  initStarted: false,
  init: async () => {
    if (get().initStarted) return;
    set({ initStarted: true });
    // Refresh on tab-visible so the daemon status is fresh when the
    // user comes back. Cheap: one GET, server is an in-memory map
    // walk + a JSON parse. The listener is never removed because
    // the store is a process singleton.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void get().refresh();
        }
      });
    }
    // Same singleton-lifetime story for the workspace-readiness retry:
    // if the user opened Settings on the WorkspaceSetupPage, our first
    // fetch 503'd against the workspace guard and `error` would stick.
    // Clear it and re-fetch the moment the workspace becomes
    // configured so the next Settings open does not toast a stale
    // "Workspace has not been configured" message.
    if (typeof window !== 'undefined') {
      window.addEventListener('workspace-changed', () => {
        set({ error: null });
        void get().refresh();
      });
    }
    await get().refresh();
  },
  refresh: () => {
    if (inFlightRefresh) return inFlightRefresh;
    const request = (async () => {
      set({ loading: true });
      try {
        const res = await listAcpProfiles();
        set({
          profiles: res.profiles,
          selectableProfileIds: res.selectableProfileIds,
          agentlet: res.agentlet,
          loaded: true,
          error: null,
          loading: false,
        });
      } catch (err) {
        // Leave the previous snapshot in place so transient errors
        // don't make the picker flicker between "available" and empty.
        set({
          error: err instanceof Error ? err : new Error(String(err)),
          loading: false,
        });
      }
    })();
    inFlightRefresh = request;
    void request.finally(() => {
      if (inFlightRefresh === request) inFlightRefresh = null;
    });
    return request;
  },
}));
