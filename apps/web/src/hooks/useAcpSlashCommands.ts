/**
 * `useAcpSlashCommands` — fetch and cache the agent-defined slash
 * commands for the active thread's external binding.
 *
 * Active only when the thread is bound to an external agent
 * (`binding.kind === 'external'`). For internal bindings it returns
 * an empty list and never hits the server.
 *
 * Two refresh paths:
 *  1. **Bootstrap** — runs on mount and whenever `{threadId, binding,
 *     canvasId}` changes. Calls `ensureAcpSession` (opens or reuses
 *     the per-thread session) and, if the agent hasn't pushed yet,
 *     re-pulls once after {@link RETRY_DELAY_MS} to catch late
 *     `available_commands_update` arrivals.
 *  2. **On-demand** — {@link UseAcpSlashCommandsResult.refreshIfStale}
 *     is invoked by the typeahead host (e.g. ChatInput) on the
 *     rising edge of "user wants the slash menu". A TTL gate
 *     ({@link STALE_TTL_MS} by default) suppresses redundant
 *     network traffic when the user opens / closes the menu in
 *     rapid succession. This lets the UI pick up commands the agent
 *     pushes mid-session without polling.
 *
 * Why two passes (bootstrap immediate + delayed re-pull):
 *  - ACP's `available_commands_update` is a push from the agent and
 *    the spec does NOT guarantee timing. In practice agents send it
 *    within a few hundred ms of `session/new` resolving, but anywhere
 *    in that window the response could be empty.
 *  - The immediate POST returns whatever's cached right now (possibly
 *    `[]`). A second GET after 200 ms catches the late push so the
 *    typeahead has data by the time the user types `/`.
 *
 * Errors are stored on `error` but never thrown — slash-command
 * typeahead is a convenience, not a critical feature, and a failure
 * should silently degrade to no popover rather than disrupt chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureAcpSession, getAcpThreadCommands } from '@/api/acp';

import type { AgentBinding, AvailableCommand } from '@sediment/shared';

/** Delay before the follow-up re-pull, in ms. See file header for rationale. */
const RETRY_DELAY_MS = 200;

/**
 * Default "freshness" window used by {@link UseAcpSlashCommandsResult.refreshIfStale}.
 * A fetch younger than this is treated as still-current and the call
 * becomes a no-op. 10 s strikes a balance: typing `/x` `/y` `/z` in
 * quick succession only triggers one round-trip, while menu opens a
 * few keystrokes apart will pick up a freshly-pushed command set.
 */
const STALE_TTL_MS = 10_000;

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
  /** Sediment canvasId; threaded into the ensure-session call. */
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
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
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

  // Destructure binding into stable scalars so the useCallback dep
  // array is a flat list of primitives. Internal bindings get empty
  // strings — the early-return in `refresh` skips work then.
  const bindingKind = binding.kind;
  const agentletAgentId =
    binding.kind === 'external' ? binding.agentletAgentId : '';
  const alias = binding.kind === 'external' ? binding.alias : '';

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
        agentletAgentId,
        alias,
      });
      if (!isCurrent()) return;
      setCommands(res.availableCommands);
      setError(null);
      lastFetchedAtRef.current = Date.now();

      // If the agent had not pushed yet (commands empty AND
      // updatedAt === 0), schedule a follow-up GET to catch the late
      // push. Spec offers no timing guarantee but in practice agents
      // emit `available_commands_update` within tens of ms after
      // `session/new`.
      if (res.availableCommands.length === 0 && res.updatedAt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        if (!isCurrent()) return;
        const followup = await getAcpThreadCommands(threadId);
        if (!isCurrent()) return;
        if (followup) {
          setCommands(followup.availableCommands);
          lastFetchedAtRef.current = Date.now();
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
  }, [threadId, canvasId, bindingKind, agentletAgentId, alias, enabled]);

  /**
   * Rising-edge / TTL-gated refresh — see {@link UseAcpSlashCommandsResult.refreshIfStale}.
   * Identity is stable across renders thanks to ref-based gate reads.
   */
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
    // Clear stale commands the moment binding (or thread / canvas)
    // changes, BEFORE the new fetch resolves. Without this an
    // external→external switch keeps the previous agent's commands
    // visible during the loading window, so the user momentarily
    // sees the wrong typeahead. Internal bindings hit the same
    // setter inside refresh() but doing it here too avoids a flicker
    // when the refresh callback identity hasn't changed yet.
    setCommands([]);
    setError(null);
    void refresh();
    return () => {
      // Bump the epoch so any in-flight refresh from this effect
      // run becomes stale and skips its state writes. The rule
      // below warns because cleanup may see a different
      // `epochRef.current` than effect setup did — that's exactly
      // the behaviour we want here (the value moves forward each
      // refresh), so the warning does not apply.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epochRef.current++;
    };
  }, [refresh]);

  return { commands, loading, error, refresh, refreshIfStale };
}
