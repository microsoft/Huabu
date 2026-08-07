// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `useInternalSlashCommands` — fetch and cache the user-invokable
 * skill catalogue for the active **internal**-bound thread.
 *
 * Mirror counterpart to {@link useAcpSlashCommands}: same return
 * shape (`{ commands, loading, error, refresh, refreshIfStale }`)
 * so ChatPanel can switch sources on `agentBinding.kind` without
 * the typeahead/menu components caring which side they came from.
 *
 * Why a separate hook (and not "always merged in one")?
 *  - Sources are independent: ACP slash commands originate from the
 *    bound external agent (push via `available_commands_update`);
 *    internal slash commands originate from the workspace's
 *    `setting/skills/` directory (user-authored Markdown). Mixing
 *    them on one thread would make `/x` ambiguous when an external
 *    agent and a user skill happen to share a name.
 *  - Caching strategies differ: ACP needs an initial post + delayed
 *    re-pull to catch the agent's first push; internal needs a flat
 *    GET. Trying to share machinery would muddle both.
 *
 * Listing is filtered server-side to `user` / `merged` skills only —
 * system skills remain in the agent's catalogue but are not surfaced
 * to the user's `/` menu. See `apps/server/src/modules/agent/skills.route.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { listSkills } from '@/api/skills';

import type { AgentBinding, AvailableCommand, SkillScope } from '@huabu/shared';

/**
 * Default staleness window for {@link UseInternalSlashCommandsResult.refreshIfStale}.
 * Tuned the same as the ACP hook so the two feel identical to the user:
 * opening the menu twice in quick succession only triggers one fetch,
 * while pauses long enough to author a new skill via fs_write pick it
 * up.
 */
const STALE_TTL_MS = 10_000;

export interface UseInternalSlashCommandsResult {
  /** Currently-known slash commands. Empty until the first fetch resolves. */
  commands: AvailableCommand[];
  /** True while a fetch is in flight. */
  loading: boolean;
  /** Last error from a fetch, or `null`. Errors degrade silently to an empty list. */
  error: Error | null;
  /** Manual re-fetch. Safe to call concurrently. */
  refresh: () => Promise<void>;
  /**
   * Re-fetch IFF the last successful fetch is older than `ttlMs`
   * (default {@link STALE_TTL_MS}) AND no fetch is currently in flight.
   * Identity is stable across renders so it can be used as a useEffect
   * dep without triggering spurious calls.
   */
  refreshIfStale: (ttlMs?: number) => void;
}

export interface UseInternalSlashCommandsOptions {
  /** Active thread binding. Hook self-disables for external bindings. */
  binding: AgentBinding;
  /**
   * Current chat surface (`ask` / `operate`). Forwarded as the
   * `scope` query so the menu hides skills that don't apply to the
   * active mode (e.g. sketch-only skills never show in `/`).
   */
  scope?: SkillScope;
  /**
   * Master enable switch. When `false`, the hook behaves as if the
   * binding were external: no fetch, empty `commands`, no error.
   * Defaults to `true`.
   */
  enabled?: boolean;
}

/**
 * Subscribe to the user-invokable skill catalogue for the active
 * internal-bound thread.
 */
export function useInternalSlashCommands({
  binding,
  scope,
  enabled = true,
}: UseInternalSlashCommandsOptions): UseInternalSlashCommandsResult {
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Monotonic epoch — see useAcpSlashCommands for the rationale.
  // Each fetch captures the current value; stale resumes detect
  // their epoch is behind and skip state writes.
  const epochRef = useRef(0);
  const loadingRef = useRef(false);
  const lastFetchedAtRef = useRef(0);

  const bindingKind = binding.kind;
  const active = bindingKind === 'internal' && enabled;

  const refresh = useCallback(async () => {
    const myEpoch = ++epochRef.current;
    const isCurrent = () => epochRef.current === myEpoch;

    if (!active) {
      // External binding (or master-disabled): mirror the ACP hook's
      // behaviour for symmetry — clear the list so a freshly-switched
      // external binding does not leave the previous user skills
      // visible during the changeover.
      setCommands([]);
      setError(null);
      setLoading(false);
      loadingRef.current = false;
      return;
    }
    setLoading(true);
    loadingRef.current = true;
    try {
      const res = await listSkills(scope);
      if (!isCurrent()) return;
      // Map skill metadata to the AvailableCommand shape the typeahead
      // already understands. `name` is the skill id (what the user types
      // after `/`), `description` carries the catalogue blurb. No input
      // hint today — skills accept free-text via the regular message body.
      const mapped: AvailableCommand[] = res.skills.map((s) => ({
        name: s.id,
        description: s.description,
      }));
      setCommands(mapped);
      setError(null);
      lastFetchedAtRef.current = Date.now();
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      // Do NOT bump lastFetchedAtRef on failure so the next
      // refreshIfStale retries rather than being throttled by a
      // poisoned timestamp.
    } finally {
      if (isCurrent()) setLoading(false);
      loadingRef.current = false;
    }
  }, [active, scope]);

  const refreshIfStale = useCallback(
    (ttlMs: number = STALE_TTL_MS) => {
      if (loadingRef.current) return;
      const last = lastFetchedAtRef.current;
      if (last > 0 && Date.now() - last < ttlMs) return;
      void refresh();
    },
    [refresh],
  );

  useEffect(() => {
    // Clear stale entries before the new fetch resolves so a
    // binding/scope switch never momentarily shows the previous list.
    setCommands([]);
    setError(null);
    void refresh();
    return () => {
      // Bump the epoch so any in-flight refresh becomes stale and
      // skips its state writes. eslint-disable matches the ACP hook's
      // rationale: epoch is intentionally a moving target across runs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epochRef.current++;
    };
  }, [refresh]);

  return { commands, loading, error, refresh, refreshIfStale };
}
