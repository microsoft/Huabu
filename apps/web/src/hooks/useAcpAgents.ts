/**
 * `useAcpAgents` — Subscribe to the connected-agents list with
 * on-demand refresh.
 *
 * Thin wrapper around the singleton {@link useAcpAgentsStore}. All
 * consumers share the same agents list, so any caller — including
 * cross-component triggers like the Settings popover detecting a
 * fresh pairing claim — can refresh once and be sure every subscriber
 * sees the new data on the next render. See the store's module
 * comment for the rationale behind the centralisation.
 *
 * Behaviour from a consumer's perspective is unchanged:
 *  - One initial fetch happens at mount so the dropdown has data the
 *    first time it opens.
 *  - Subsequent fetches are explicit via `refresh()`.
 *  - Errors are stored on `error` but do not throw.
 *  - `loaded` flips true only after the first successful fetch.
 */

import { useEffect } from 'react';

import { useAcpAgentsStore } from '@/store/acpAgentsStore';

import type { AcpAgentSummary } from '@/api/acp';

export interface UseAcpAgentsResult {
  /** Currently-connected agents. Empty array until the first fetch resolves. */
  agents: AcpAgentSummary[];
  /**
   * `true` once the initial fetch has resolved at least once. Consumers
   * should treat the agents list as authoritative only after this flips
   * — otherwise a stale binding may be cleared prematurely on mount.
   */
  loaded: boolean;
  /** Last error from a fetch, or `null`. Cleared on the next successful fetch. */
  error: Error | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /**
   * Trigger a fresh `GET /api/acp/agents`. Safe to call concurrently —
   * later calls overwrite earlier in-flight state. Returns the promise
   * so callers can `await` if they want.
   */
  refresh: () => Promise<void>;
}

export function useAcpAgents(): UseAcpAgentsResult {
  const agents = useAcpAgentsStore((s) => s.agents);
  const loaded = useAcpAgentsStore((s) => s.loaded);
  const error = useAcpAgentsStore((s) => s.error);
  const loading = useAcpAgentsStore((s) => s.loading);
  const init = useAcpAgentsStore((s) => s.init);
  const refresh = useAcpAgentsStore((s) => s.refresh);

  // Idempotent: the store dedupes across multiple consumers mounting
  // in parallel, so only the first one actually fires a network call.
  useEffect(() => {
    void init();
  }, [init]);

  return { agents, loaded, error, loading, refresh };
}
