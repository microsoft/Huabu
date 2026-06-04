/**
 * `useAcpProfiles` — Subscribe to the external-agent profiles list
 * with on-demand refresh.
 *
 * Thin wrapper around the singleton {@link useAcpProfilesStore}. All
 * consumers share the same list, so any caller — including the
 * Settings editor's create/update/delete flow — can refresh once and
 * be sure every subscriber sees the new data on the next render. See
 * the store's module comment for the centralisation rationale.
 *
 * Behaviour from a consumer's perspective:
 *  - One initial fetch happens at mount so the picker has data the
 *    first time it opens.
 *  - Subsequent fetches are explicit via `refresh()`.
 *  - Errors are stored on `error` but do not throw.
 *  - `loaded` flips true only after the first successful fetch.
 *  - The daemon's current liveness snapshot is exposed alongside the
 *    profile list so consumers don't need a second GET.
 */

import { useEffect } from 'react';

import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import type { AcpAgentProfileWithRuntime, AcpDaemonStatus } from '@/api/acp';

export interface UseAcpProfilesResult {
  /** Every profile the user has created. Empty until the first fetch resolves. */
  profiles: AcpAgentProfileWithRuntime[];
  /** Latest daemon snapshot, or `null` while the first fetch is in flight. */
  daemon: AcpDaemonStatus | null;
  /**
   * `true` once the initial fetch has resolved at least once. Consumers
   * should treat the profile list as authoritative only after this flips
   * — otherwise a stale binding may be cleared prematurely on mount.
   */
  loaded: boolean;
  /** Last error from a fetch, or `null`. Cleared on the next successful fetch. */
  error: Error | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /**
   * Trigger a fresh `GET /api/acp/profiles`. Safe to call concurrently
   * — later calls overwrite earlier in-flight state. Returns the promise
   * so callers can `await` if they want.
   */
  refresh: () => Promise<void>;
}

export function useAcpProfiles(): UseAcpProfilesResult {
  const profiles = useAcpProfilesStore((s) => s.profiles);
  const daemon = useAcpProfilesStore((s) => s.daemon);
  const loaded = useAcpProfilesStore((s) => s.loaded);
  const error = useAcpProfilesStore((s) => s.error);
  const loading = useAcpProfilesStore((s) => s.loading);
  const init = useAcpProfilesStore((s) => s.init);
  const refresh = useAcpProfilesStore((s) => s.refresh);

  // Idempotent: the store dedupes across multiple consumers mounting
  // in parallel, so only the first one actually fires a network call.
  useEffect(() => {
    void init();
  }, [init]);

  return { profiles, daemon, loaded, error, loading, refresh };
}
