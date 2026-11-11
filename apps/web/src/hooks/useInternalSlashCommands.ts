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

import { createWorkspaceCache } from './workspaceCache';

import type { AgentBinding, AvailableCommand, SkillScope } from '@huabu/shared';

/**
 * Default staleness window for {@link UseInternalSlashCommandsResult.refreshIfStale}.
 * Tuned the same as the ACP hook so the two feel identical to the user:
 * opening the menu twice in quick succession only triggers one fetch,
 * while pauses long enough to author a new skill via fs_write pick it
 * up.
 */
const STALE_TTL_MS = 10_000;

interface CachedInternalSlashCommandsEntry {
  commands: AvailableCommand[];
  fetchedAt: number;
}

const useInternalSlashCommandsCache =
  createWorkspaceCache<CachedInternalSlashCommandsEntry>();

function internalSlashCacheKey(scope: SkillScope | undefined): string {
  return scope ?? '__default__';
}

export function clearInternalSlashCommandsCache(): void {
  useInternalSlashCommandsCache.getState().clear();
}

export interface UseInternalSlashCommandsResult {
  /** Currently-known slash commands. Empty until the first fetch resolves. */
  commands: AvailableCommand[];
  /** True while the initial catalogue is loading; warm refreshes stay silent. */
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
  const internalSlashCommandsCache = useInternalSlashCommandsCache();
  const bindingKind = binding.kind;
  const active = bindingKind === 'internal' && enabled;
  const cacheKey = active ? internalSlashCacheKey(scope) : null;
  const initialCached = cacheKey
    ? internalSlashCommandsCache.get(cacheKey)
    : undefined;

  const [commands, setCommands] = useState<AvailableCommand[]>(
    () => initialCached?.commands ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Monotonic epoch — see useAcpSlashCommands for the rationale.
  // Each fetch captures the current value; stale resumes detect
  // their epoch is behind and skip state writes.
  const epochRef = useRef(0);
  const loadingRef = useRef(false);
  const lastFetchedAtRef = useRef(initialCached?.fetchedAt ?? 0);
  const invalidatePending = useCallback(() => {
    epochRef.current++;
    loadingRef.current = false;
  }, []);

  const refresh = useCallback(async () => {
    const myEpoch = ++epochRef.current;
    const isCurrent = () =>
      epochRef.current === myEpoch &&
      useInternalSlashCommandsCache.getState() === internalSlashCommandsCache;

    if (!active || !cacheKey) {
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
    if (!internalSlashCommandsCache.has(cacheKey)) {
      setLoading(true);
    }
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
      const fetchedAt = Date.now();
      internalSlashCommandsCache.set(cacheKey, {
        commands: mapped,
        fetchedAt,
      });
      setCommands(mapped);
      setError(null);
      lastFetchedAtRef.current = fetchedAt;
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      // Do NOT bump lastFetchedAtRef on failure so the next
      // refreshIfStale retries rather than being throttled by a
      // poisoned timestamp.
    } finally {
      if (isCurrent()) {
        setLoading(false);
        loadingRef.current = false;
      }
    }
  }, [active, scope, cacheKey, internalSlashCommandsCache]);

  const refreshIfStale = useCallback(
    (ttlMs: number = STALE_TTL_MS) => {
      if (loadingRef.current) return;
      const last =
        (cacheKey
          ? internalSlashCommandsCache.get(cacheKey)?.fetchedAt
          : undefined) ?? lastFetchedAtRef.current;
      if (last > 0 && Date.now() - last < ttlMs) return;
      void refresh();
    },
    [cacheKey, refresh, internalSlashCommandsCache],
  );

  useEffect(() => {
    if (!cacheKey) {
      setCommands([]);
      setError(null);
      setLoading(false);
      lastFetchedAtRef.current = 0;
      return invalidatePending;
    }

    const cached = internalSlashCommandsCache.get(cacheKey);

    if (cached) {
      setCommands(cached.commands);
      setError(null);
      setLoading(false);
      lastFetchedAtRef.current = cached.fetchedAt;
      if (Date.now() - cached.fetchedAt >= STALE_TTL_MS) {
        void refresh();
      }
      return invalidatePending;
    }

    setCommands([]);
    setError(null);
    lastFetchedAtRef.current = 0;
    void refresh();
    return invalidatePending;
  }, [cacheKey, refresh, internalSlashCommandsCache, invalidatePending]);

  return { commands, loading, error, refresh, refreshIfStale };
}
