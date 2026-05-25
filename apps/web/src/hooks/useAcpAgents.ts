/**
 * `useAcpAgents` — Poll `GET /api/acp/agents` and expose the current
 * connected-agents list to React components.
 *
 * Phase 2 PR A surface — used by the ChatPanel indicator. PR B will reuse
 * the same hook to power the `@`-autocomplete dropdown.
 *
 * Design notes:
 *  - Polls every {@link DEFAULT_POLL_MS}; the request is cheap and the
 *    server response is small enough that we don't bother with SSE yet
 *    (see plan doc §Phase 2 "PR breakdown" and §Phase 3 ideas about a
 *    control-plane event stream).
 *  - Errors are stored on `error` but do not throw — the indicator
 *    silently hides instead of disrupting the chat.
 *  - When `enabled: false` (bridge feature flag off), `agents` is `[]`
 *    and the consumer should not show empty-state copy unless it also
 *    wants to advertise the bridge.
 */

import { useEffect, useRef, useState } from 'react';

import { listAcpAgents } from '@/api/acp';

import type { AcpAgentSummary } from '@/api/acp';

/** How often to refresh the agent list, in ms. */
export const DEFAULT_POLL_MS = 3000;

export interface UseAcpAgentsResult {
  /** Currently-connected agents. Empty array while loading or when none connected. */
  agents: AcpAgentSummary[];
  /**
   * Whether the bridge is enabled server-side. `null` until the first
   * response lands. Consumers should treat `null` as "unknown — don't show
   * UI yet" to avoid a flash of empty state.
   */
  enabled: boolean | null;
  /** Last error from polling, or `null`. Stale errors are cleared on success. */
  error: Error | null;
}

export interface UseAcpAgentsOptions {
  /** Override the default polling interval (3s). */
  pollMs?: number;
  /** Pause polling when the consumer is hidden. Defaults to `true`. */
  active?: boolean;
}

/**
 * Subscribe to the connected-agents list with low-frequency polling.
 *
 * Safe to mount multiple instances — each runs its own interval. The
 * server response is tiny; if call volume becomes a concern, hoist this
 * into a single store entry.
 */
export function useAcpAgents(
  options: UseAcpAgentsOptions = {},
): UseAcpAgentsResult {
  const { pollMs = DEFAULT_POLL_MS, active = true } = options;

  const [agents, setAgents] = useState<AcpAgentSummary[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // `useRef` so the cleanup closure always sees the latest interval id
  // even when the dep array re-runs the effect mid-flight.
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!active) return;

    cancelledRef.current = false;

    const fetchOnce = async () => {
      try {
        const res = await listAcpAgents();
        if (cancelledRef.current) return;
        setAgents(res.agents);
        setEnabled(res.enabled);
        setError(null);
      } catch (err) {
        if (cancelledRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        // Leave `agents` and `enabled` untouched so brief blips don't
        // make the indicator flicker.
      }
    };

    void fetchOnce();
    timerRef.current = setInterval(fetchOnce, pollMs);

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, pollMs]);

  return { agents, enabled, error };
}
