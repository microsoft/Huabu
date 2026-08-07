// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `useAcpSlashCommands` — fetch and cache the agent-defined slash
 * commands for the active thread's external binding.
 *
 * Active only when the thread is bound to an external agent
 * (`binding.kind === 'external'`). For internal bindings it returns
 * an empty list and never hits the server.
 *
 * Session creation is **lazy**: selecting an external agent in the
 * menu does NOT immediately contact the agentlet daemon. The first
 * ACP session is created on-demand when the user opens the slash
 * menu or sends the first message — via {@link refreshIfStale}.
 *
 * Two refresh paths:
 *  1. **On-demand** — {@link UseAcpSlashCommandsResult.refreshIfStale}
 *     is invoked by the typeahead host (e.g. ChatInput) on the
 *     rising edge of "user wants the slash menu". A TTL gate
 *     ({@link STALE_TTL_MS} by default) suppresses redundant
 *     network traffic when the user opens / closes the menu in
 *     rapid succession. This is the primary entry point.
 *  2. **Manual** — {@link UseAcpSlashCommandsResult.refresh} can be
 *     called explicitly when the caller knows the cache is stale.
 *
 * Why no bootstrap effect: agent profiles are templates — no session
 * is created until the user actually interacts. The agentlet daemon
 * auto-suspends idle sessions (via `idleTimeoutSecs`), so avoiding
 * eager session creation reduces unnecessary daemon traffic.
 *
 * Errors are stored on `error` but never thrown — slash-command
 * typeahead is a convenience, not a critical feature, and a failure
 * should silently degrade to no popover rather than disrupt chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureAcpSession, getAcpThreadCommands } from '@/api/acp';

import type { AgentBinding, AvailableCommand } from '@huabu/shared';

/**
 * Backoff schedule (ms) for the follow-up re-pulls issued while the
 * command list is still empty after `ensureAcpSession`.
 *
 * The agent pushes `available_commands_update` shortly after
 * `session/new`, but `ensureAcpSession` returns the sessionId before
 * the agentlet relay has even attached (the daemon answers the spawn
 * RPC right after opening the bridge socket). So the commands land in
 * the server-side registry a few hundred ms LATER. On a cold spawn
 * the agent CLI itself can take many seconds to boot before it even
 * emits the list, so we poll persistently with growing gaps until it
 * arrives. The cumulative budget below spans ~30 s, after which we
 * give up and let the short empty-state TTL drive the next attempt on
 * the following menu open.
 */
const EMPTY_POLL_BACKOFF_MS = [
  200, 300, 500, 800, 1200, 1500, 2000, 2500, 3000, 3000, 3000, 3000, 3000,
  3000,
];

/**
 * localStorage key prefix for the per-profile slash-command cache.
 * The agent's command catalogue is effectively static per profile
 * (Copilot advertises the same ~34 commands for every session), so we
 * persist the last-known list keyed by `profileId` and seed the menu
 * from it OPTIMISTICALLY on the next thread. This collapses the cold
 * spawn wait (agent boot + first `available_commands_update`) from
 * many seconds to instant for any agent the user has used before; the
 * real list silently reconciles once the fresh fetch resolves.
 */
const CACHE_KEY_PREFIX = 'huabu.acp.slashCommands.';

/** Read the cached command list for a profile, or `[]` on miss/parse error. */
function readCachedCommands(profileId: string): AvailableCommand[] {
  if (!profileId) return [];
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + profileId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AvailableCommand[]) : [];
  } catch {
    return [];
  }
}

/** Persist the command list for a profile. Best-effort; swallows quota errors. */
function writeCachedCommands(
  profileId: string,
  commands: AvailableCommand[],
): void {
  if (!profileId) return;
  try {
    localStorage.setItem(
      CACHE_KEY_PREFIX + profileId,
      JSON.stringify(commands),
    );
  } catch {
    // localStorage unavailable or over quota — the cache is a pure
    // optimization, so a write failure degrades gracefully to the
    // network path.
  }
}

/**
 * Default "freshness" window used by {@link UseAcpSlashCommandsResult.refreshIfStale}.
 * A fetch younger than this is treated as still-current and the call
 * becomes a no-op. 10 s strikes a balance: typing `/x` `/y` `/z` in
 * quick succession only triggers one round-trip, while menu opens a
 * few keystrokes apart will pick up a freshly-pushed command set.
 */
const STALE_TTL_MS = 10_000;

/**
 * Much shorter staleness window applied while the command cache is
 * still EMPTY. The agent pushes `available_commands_update` right
 * after `session/new`, but that arrives in the server registry a
 * short moment after `ensureAcpSession` has already returned the
 * sessionId (the bridge relay attaches asynchronously). So once the
 * cache is non-empty {@link STALE_TTL_MS} throttles re-pulls, but
 * while it is empty we re-pull aggressively so the menu recovers the
 * moment the agent's list lands instead of being suppressed by the
 * full 10 s freshness window.
 */
const EMPTY_RETRY_TTL_MS = 1_500;

export interface UseAcpSlashCommandsResult {
  /** Currently-known slash commands. Empty until a fetch resolves with data. */
  commands: AvailableCommand[];
  /** True while ANY of the in-flight requests are pending. */
  loading: boolean;
  /** Last error from a fetch, or `null`. */
  error: Error | null;
  /** Manual re-fetch. Safe to call concurrently — returns the promise. */
  refresh: () => Promise<void>;
  /**
   * Re-fetch IFF the last successful fetch is older than `ttlMs`
   * (default {@link STALE_TTL_MS}) AND no fetch is currently in
   * flight. Identity is stable across renders so it can be used as a
   * `useEffect` dependency without triggering spurious calls.
   *
   * Intended for rising-edge triggers (e.g. textarea transitions from
   * "plain text" to "starts with /"). Safe to call frequently — the
   * TTL gate is the throttle.
   */
  refreshIfStale: (ttlMs?: number) => void;
}

export interface UseAcpSlashCommandsOptions {
  threadId: string | null | undefined;
  binding: AgentBinding;
  /** Huabu canvasId; threaded into the ensure-session call. */
  canvasId?: string | null;
  /**
   * Master enable switch. When `false`, the hook behaves as if the
   * binding were internal: no fetch, empty `commands`, no error. Use
   * this to gate the request on a precondition the hook can't see
   * itself — e.g. "the bound external agent is currently connected
   * to the bridge" — so we don't fire a guaranteed-to-fail request.
   * Defaults to `true` for backwards-compat with the original API.
   */
  enabled?: boolean;
}

/**
 * Subscribe to the slash-command list for a thread bound to an
 * external agent. The hook auto-fetches whenever
 * `{threadId, binding, canvasId}` changes; internal bindings disable
 * the hook entirely.
 */
export function useAcpSlashCommands({
  threadId,
  binding,
  canvasId,
  enabled = true,
}: UseAcpSlashCommandsOptions): UseAcpSlashCommandsResult {
  // Destructure binding into stable scalars so the useCallback dep
  // array is a flat list of primitives. Internal bindings get empty
  // strings — the early-return in `refresh` skips work then.
  const bindingKind = binding.kind;
  const profileId = binding.kind === 'external' ? binding.profileId : '';

  // Seed OPTIMISTICALLY from the per-profile cache so a returning
  // agent's menu paints instantly instead of waiting for a cold
  // spawn. Lazy initializer runs once; the binding-change effect
  // below keeps it in sync when the thread/profile switches.
  const [commands, setCommands] = useState<AvailableCommand[]>(() =>
    enabled && bindingKind === 'external' ? readCachedCommands(profileId) : [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Monotonic epoch incremented on every fetch and on every effect
  // teardown. Async resumes compare their captured epoch against the
  // current value — if it advanced, this resume is stale and must
  // not write to state. Replaces the prior shared `cancelledRef`
  // which had a TOCTOU race when a new effect setup ran while an
  // older refresh was still suspended (the ref was reset to `false`
  // before the older resume's check).
  const epochRef = useRef(0);

  // Mirrors of `loading` / last-fetch wall-clock time, accessible
  // synchronously without subscribing renders to either value.
  // `refreshIfStale` reads them inside a `useCallback` that we
  // deliberately want to keep referentially stable across renders
  // (consumers use it as a useEffect dep). State would invalidate
  // the callback on every transition.
  const loadingRef = useRef(false);
  const lastFetchedAtRef = useRef(0);

  // Synchronous mirror of `commands.length > 0`, read inside the
  // stable `refreshIfStale` callback so it can pick a shorter
  // staleness window while the cache is empty without subscribing the
  // callback identity to the `commands` value.
  const hasCommandsRef = useRef(false);

  // ── Refresh: ensure session → optional delayed re-pull ───────────
  const refresh = useCallback(async () => {
    const myEpoch = ++epochRef.current;
    const isCurrent = () => epochRef.current === myEpoch;

    if (!threadId || bindingKind !== 'external' || !enabled) {
      // Reset to empty so a freshly-switched internal binding doesn't
      // keep showing the previous agent's commands. The `!enabled`
      // branch lands here too — caller has told us the precondition
      // for a successful fetch isn't met (e.g. bound agent is
      // disconnected), so behave exactly like an internal binding.
      setCommands([]);
      setError(null);
      setLoading(false);
      loadingRef.current = false;
      // Internal bindings have nothing to fetch — leave the staleness
      // clock alone so a subsequent switch back to external still
      // forces a bootstrap on its own.
      return;
    }
    setLoading(true);
    loadingRef.current = true;
    try {
      const res = await ensureAcpSession(threadId, {
        canvasId: canvasId ?? undefined,
        profileId,
      });
      if (!isCurrent()) return;
      setError(null);
      lastFetchedAtRef.current = Date.now();

      // Authoritative result — the agent has actually reported its
      // catalogue (non-empty list, OR an empty list with a real
      // `updatedAt` meaning "this agent genuinely has no commands").
      // Adopt it and refresh the per-profile cache. We deliberately
      // do NOT overwrite an optimistically-seeded list with an empty
      // array while `updatedAt === 0` (commands simply haven't landed
      // yet) — that would blank a returning agent's menu mid-spawn.
      if (res.availableCommands.length > 0 || res.updatedAt > 0) {
        setCommands(res.availableCommands);
        writeCachedCommands(profileId, res.availableCommands);
      }

      // If the agent had not pushed yet (commands empty AND
      // updatedAt === 0), poll with growing gaps to catch the push
      // that lands in the registry once the bridge relay attaches and
      // the (possibly cold-booting) agent emits its list. Stop as
      // soon as the list arrives or this resume goes stale. Any
      // optimistic cache stays visible throughout.
      if (res.availableCommands.length === 0 && res.updatedAt === 0) {
        for (const delay of EMPTY_POLL_BACKOFF_MS) {
          await new Promise((r) => setTimeout(r, delay));
          if (!isCurrent()) return;
          const followup = await getAcpThreadCommands(
            threadId,
            canvasId ?? undefined,
          );
          if (!isCurrent()) return;
          if (followup && followup.availableCommands.length > 0) {
            setCommands(followup.availableCommands);
            writeCachedCommands(profileId, followup.availableCommands);
            lastFetchedAtRef.current = Date.now();
            break;
          }
        }
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      // Leave `commands` untouched so transient errors don't make
      // the typeahead flicker between populated and empty. Do NOT
      // bump `lastFetchedAtRef` — the next `refreshIfStale` should
      // retry instead of being throttled.
    } finally {
      if (isCurrent()) setLoading(false);
      // Always release the loading gate: a stale resume that skipped
      // the state write above still needs to flip the ref so
      // `refreshIfStale` doesn't deadlock waiting on a phantom load.
      // (Multiple in-flight refreshes can briefly overlap during a
      // binding switch; whichever finishes last clears the flag, and
      // the winner of the epoch race is the one that matters.)
      loadingRef.current = false;
    }
  }, [threadId, canvasId, bindingKind, profileId, enabled]);

  /**
   * Rising-edge / TTL-gated refresh — see {@link UseAcpSlashCommandsResult.refreshIfStale}.
   * Identity is stable across renders thanks to ref-based gate reads.
   */
  const refreshIfStale = useCallback(
    (ttlMs: number = STALE_TTL_MS) => {
      if (loadingRef.current) return;
      // While the cache is empty, fall back to the aggressive
      // empty-state window so a late `available_commands_update`
      // (pushed shortly after `session/new`) is picked up on the next
      // menu open instead of being throttled by the full freshness
      // TTL.
      const effectiveTtl = hasCommandsRef.current
        ? ttlMs
        : Math.min(ttlMs, EMPTY_RETRY_TTL_MS);
      const last = lastFetchedAtRef.current;
      if (last > 0 && Date.now() - last < effectiveTtl) return;
      void refresh();
    },
    [refresh],
  );

  // Keep the synchronous mirror in lock-step with the rendered list
  // so `refreshIfStale` can branch on "do we have commands yet?"
  // without taking `commands` as a callback dependency.
  useEffect(() => {
    hasCommandsRef.current = commands.length > 0;
  }, [commands]);

  // Re-seed the menu when binding/thread/canvas changes so an
  // external→external switch never shows the previous agent's
  // typeahead. We seed from the new profile's cache (not empty) so a
  // returning agent paints instantly; an unknown profile or internal
  // binding seeds empty. Session creation stays LAZY — the actual
  // fetch happens on the first `refreshIfStale` call (slash menu open
  // or first message send), not on mount.
  useEffect(() => {
    setCommands(
      enabled && bindingKind === 'external'
        ? readCachedCommands(profileId)
        : [],
    );
    setError(null);
    lastFetchedAtRef.current = 0;
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epochRef.current++;
    };
  }, [refresh, enabled, bindingKind, profileId]);

  return { commands, loading, error, refresh, refreshIfStale };
}
