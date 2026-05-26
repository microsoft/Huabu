/**
 * `useAcpAgents` — Fetch `GET /api/acp/agents` on demand and expose the
 * current connected-agents list.
 *
 * Fetched once at mount; subsequent updates are explicit. The
 * ChatPanel's `ModeSelector` exposes a "Refresh agents" button that
 * calls `refresh()`. On-demand semantics keep request volume to the
 * bridge minimal — most of the time the agent list doesn't change.
 *
 * Design notes:
 *  - Fires one fetch at mount so the *first* dropdown open has data
 *    without an extra spinner. After that, the consumer controls when
 *    to re-fetch via `refresh()`.
 *  - Errors are stored on `error` but do not throw — the UI silently
 *    hides instead of disrupting the chat.
 *  - When `enabled: false` (bridge feature flag off), `agents` is `[]`
 *    and the consumer should not show empty-state copy unless it also
 *    wants to advertise the bridge.
 *  - `loading` flips true while a refresh is in flight so the consumer
 *    can show a spinner on the refresh affordance.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { listAcpAgents } from '@/api/acp';

import type { AcpAgentSummary } from '@/api/acp';

export interface UseAcpAgentsResult {
  /** Currently-connected agents. Empty array until the first fetch resolves. */
  agents: AcpAgentSummary[];
  /**
   * Whether the bridge is enabled server-side. `null` until the first
   * response lands. Consumers should treat `null` as "unknown — don't show
   * UI yet" to avoid a flash of empty state.
   */
  enabled: boolean | null;
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

/**
 * Subscribe to the connected-agents list with on-demand refresh.
 *
 * One initial fetch happens at mount so the dropdown has data the first
 * time it opens. All subsequent fetches must be triggered by the
 * consumer calling `refresh()`.
 */
export function useAcpAgents(): UseAcpAgentsResult {
  const [agents, setAgents] = useState<AcpAgentSummary[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);

  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAcpAgents();
      if (cancelledRef.current) return;
      setAgents(res.agents);
      setEnabled(res.enabled);
      setError(null);
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      // Leave `agents` and `enabled` untouched so transient errors don't
      // make the indicator flicker.
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  return { agents, enabled, error, loading, refresh };
}
