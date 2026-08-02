/**
 * `useAcpSessionMeta` — fetch and cache the agent-published session
 * metadata (modes / models / config options / info / usage) for the
 * active thread's external binding.
 *
 * ### Lifecycle (post per-profile-cache refactor)
 *
 * - **Mount / thread switch** — fires `GET /cached-meta`, a read-only
 *   no-spawn fetch that returns the most recent snapshot the server
 *   has cached. Lookup priority on the server:
 *     1. live registry entry (this lifetime),
 *     2. per-thread disk record (`session-store`),
 *     3. **per-profile schema cache** — schema (modes / models /
 *        config option catalogue) shared across all threads of the
 *        same profile, with `current*` defaulting to the last-known
 *        values from any session of that profile.
 *
 *   Any of (1)–(3) hitting means the toolbar populates immediately
 *   and the badge stays `connected` — **no spawn, no polling**.
 *
 * - **Cache miss → optional one-shot auto-ensure** — command Profiles
 *   chain into `refresh()` to fire a real `ensureAcpSession`. Manifest
 *   Profiles wait for their first real turn because their session must
 *   be opened through the unified Profile driver, not the legacy
 *   command-session endpoint.
 *
 * - **Post-ensure schema-empty polling** — `session/new` resolves
 *   BEFORE the agent has pushed its mode / model / config-option
 *   catalogues (Copilot CLI pushes those 1–3s later). Those pushes
 *   land in the server registry / profile cache but DON'T reach the
 *   web until an SSE stream opens (i.e. the user sends a message).
 *   To avoid the "connected but selectors empty until first message"
 *   trap, `refresh()` keeps polling `/cached-meta` (no-spawn) for up
 *   to ~60s after a schema-empty ensure resolves, stopping as soon as
 *   the agent's push lands. The window has to cover cold-start cases
 *   (Copilot CLI launching in a fresh cwd, including auth + workspace
 *   indexing, can take 15–30s before the first `config_option_update`
 *   ships). `loading` is flipped off the moment ensure resolves so
 *   the badge doesn't stay `connecting` during the poll window.
 *
 * - **`refresh` / `refreshIfStale`** — the spawn-triggering path.
 *   Calls `ensureAcpSession` (which DOES spawn / resume) and opens a
 *   session. Wired to `/` menu open, message-send, and set-RPC
 *   handlers in ChatPanel.
 *
 * - **SSE events** — live `session_*_update` frames are merged into
 *   the cached snapshot without a round-trip by an internal sink the
 *   hook registers via `setAcpSessionMetaSink`. Mirrored to disk on
 *   the server side (both per-thread and per-profile), so the next
 *   `/cached-meta` fetch from any client sees the freshest state.
 *   Consumers never merge frames themselves — the sink is a singleton
 *   and the hook owns it.
 *
 * Errors from `refresh` are stored on `error` but never thrown — meta
 * is a polish surface; a failure should degrade to no selectors rather
 * than disrupt chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '@/api/_client';
import { ensureAcpSession, getAcpThreadCachedMeta } from '@/api/acp';
import {
  setAcpSessionMetaSink,
  type AcpSessionMetaStreamEvent,
} from '@/hooks/useAgentStream';

import type {
  AcpEnsureErrorCode,
  AcpSessionMetaSnapshot,
  AgentBinding,
} from '@sediment/shared';

const STALE_TTL_MS = 10_000;

/**
 * Offsets (relative to ensure-resolved) for the post-ensure cached-
 * meta polling loop. See `refresh()` for rationale.
 *
 * Total window: ~60s with exponential-ish backoff. Each poll hits
 * `/cached-meta` (no spawn, no auth, no agent round-trip) and commits
 * as soon as the server's cached snapshot becomes schema-non-empty
 * (i.e. the agent's async push has landed in the registry / profile
 * cache).
 *
 * The window MUST cover cold-start cases like Copilot CLI launching
 * in a brand-new cwd (auth handshake + workspace indexing can easily
 * push the first `config_option_update` out to 15–30s). A short
 * window would silently fall back to "only populate on first message
 * send", which is exactly the regression we're solving.
 */
const POST_ENSURE_POLL_OFFSETS_MS = [
  400, 1000, 2000, 3000, 5000, 8000, 12000, 15000, 15000,
] as const;

/**
 * A snapshot is "schema-empty" when none of the three schema-bearing
 * fields have content. This is the canonical "agent hasn't pushed
 * its catalogues yet" state and is what triggers post-ensure
 * polling: `session/new` resolves before the agent's async
 * `config_option_update` / mode catalogues arrive, so the first
 * snapshot is usable for chat but the selector dropdowns would be
 * empty without a follow-up fetch.
 */
function isSchemaEmpty(snapshot: AcpSessionMetaSnapshot): boolean {
  return (
    snapshot.configOptions.length === 0 &&
    snapshot.availableModes.length === 0 &&
    snapshot.availableModels.length === 0
  );
}

/** Empty snapshot used while no session has been opened. */
const EMPTY_META: AcpSessionMetaSnapshot = {
  availableModes: [],
  currentModeId: null,
  availableModels: [],
  currentModelId: null,
  configOptions: [],
  selections: {},
  sessionInfo: null,
  usage: null,
  updatedAt: 0,
};

/** Subset of `AgentStreamEvent` types this hook merges into the snapshot. */
export type AcpSessionMetaEvent = AcpSessionMetaStreamEvent;

/**
 * Patch shape accepted by {@link UseAcpSessionMetaResult.applyOptimistic}.
 *
 * `selection` records this thread's explicit choice for one knob, keyed the
 * same way the server keys `AcpSessionMetaSnapshot.selections` (a
 * config-option id, or the reserved `'mode'` / `'model'`). It is the field
 * the selector UI actually reads, so writing it is what makes a pill update
 * before the set-RPC round-trip resolves. Pass `value: null` to drop the
 * selection again, which is how a failed RPC reverts: the pill falls back to
 * whatever the agent reports rather than to a second guess of its own.
 */
export interface AcpSessionMetaOptimisticPatch {
  selection?: { id: string; value: string | boolean | null };
}

export interface UseAcpSessionMetaResult {
  /** Snapshot the server most recently confirmed. Never null. */
  meta: AcpSessionMetaSnapshot;
  /** True while ANY in-flight fetch is pending. */
  loading: boolean;
  /** Last error from a fetch, or `null`. */
  error: Error | null;
  /**
   * Categorical reason for {@link error} when the server returned a
   * recognised `AcpEnsureErrorCode`. `null` when there is no error,
   * the error was a non-API throw (network down), or the server
   * returned an unknown / legacy code. Consumers use this to pick a
   * remediation-specific tooltip / CTA (e.g. "Restart worker" for
   * `worker_not_ready`, "Re-create profile" for `profile_missing`).
   */
  errorCode: AcpEnsureErrorCode | null;
  /** Manual re-fetch. */
  refresh: () => Promise<void>;
  /** TTL-gated re-fetch (see file header). */
  refreshIfStale: (ttlMs?: number) => void;
  /**
   * Apply a client-side optimistic patch (no SSE equivalent required).
   * Use for set-RPC handlers that want the selector to update
   * immediately, and to revert on RPC failure by re-applying the
   * prior value.
   */
  applyOptimistic: (patch: AcpSessionMetaOptimisticPatch) => void;
}

export interface UseAcpSessionMetaOptions {
  threadId: string | null | undefined;
  binding: AgentBinding;
  canvasId?: string | null;
  /**
   * Master enable switch. When `false`, the hook behaves as if the
   * binding were internal: no fetch, empty {@link EMPTY_META}, no
   * error. Use this to gate the request on a precondition the hook
   * can't see itself — e.g. "the bound external agent is currently
   * connected to the bridge" — so we don't fire a guaranteed-to-fail
   * request that pollutes the console with 503s. Defaults to `true`
   * for backwards-compat with the original API.
   */
  enabled?: boolean;
  /**
   * Whether a total cache miss should open a session through the legacy
   * command-session endpoint. Manifest Profiles use the unified Profile
   * driver and therefore leave this disabled until the first real turn.
   */
  autoEnsureOnCacheMiss?: boolean;
}

/**
 * Subscribe to the session-meta snapshot for a thread bound to an
 * external agent. Internal bindings short-circuit to {@link EMPTY_META}.
 */
export function useAcpSessionMeta({
  threadId,
  binding,
  canvasId,
  enabled = true,
  autoEnsureOnCacheMiss = true,
}: UseAcpSessionMetaOptions): UseAcpSessionMetaResult {
  const [meta, setMeta] = useState<AcpSessionMetaSnapshot>(EMPTY_META);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Monotonic epoch for cancellation; mirrors the pattern in
  // useAcpSlashCommands — see that file for the design rationale.
  const epochRef = useRef(0);
  const loadingRef = useRef(false);
  const lastFetchedAtRef = useRef(0);

  const bindingKind = binding.kind;
  const profileId = binding.kind === 'external' ? binding.profileId : '';

  const refresh = useCallback(async () => {
    const myEpoch = ++epochRef.current;
    const isCurrent = () => epochRef.current === myEpoch;

    if (!threadId || bindingKind !== 'external' || !enabled) {
      // Internal binding (or external binding whose precondition has
      // been gated off by the caller) — nothing to fetch. Reset to
      // empty so a freshly-switched internal binding doesn't keep
      // showing the previous agent's snapshot.
      setMeta(EMPTY_META);
      setError(null);
      setLoading(false);
      loadingRef.current = false;
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
      setMeta(res.sessionMeta);
      setError(null);
      lastFetchedAtRef.current = Date.now();
      // Flip `loading` off the moment ensure resolves \u2014 the badge
      // would otherwise stay `connecting` for the entire post-ensure
      // poll window (up to 6s) even though the session is already
      // open. The polling below is a background top-up, not part of
      // the user-visible "is the agent reachable" signal.
      setLoading(false);
      loadingRef.current = false;

      // Post-ensure cached-meta polling.
      //
      // `session/new` resolves as soon as the agent acknowledges the
      // new session id — BEFORE the agent has pushed its `mode` /
      // `model` catalogues or `config_option_update` snapshot.
      // Copilot CLI in particular pushes those 1–3s later via plain
      // `session/update` notifications that land in the server's
      // registry entry but DO NOT reach the web client until an SSE
      // stream is open (which only happens during a live prompt).
      // Without polling here, the user sees "connected" but empty
      // selectors and has to send a dummy message just to populate
      // the model picker.
      //
      // We only poll when the resolved snapshot is schema-empty (no
      // configOptions, no modes, no models) — cache hits and replayed
      // sessions already have content and skip polling entirely. The
      // loop stops as soon as schema content appears OR the offset
      // list is exhausted, whichever comes first. Each call is a
      // no-spawn `/cached-meta` so it's safe to fire even when the
      // agent is dead (badge stays connected because we already have
      // a non-zero updatedAt from ensure).
      if (isSchemaEmpty(res.sessionMeta)) {
        for (const delay of POST_ENSURE_POLL_OFFSETS_MS) {
          await new Promise((r) => setTimeout(r, delay));
          if (!isCurrent()) return;
          try {
            const poll = await getAcpThreadCachedMeta(
              threadId,
              canvasId ?? undefined,
              profileId || undefined,
            );
            if (!isCurrent()) return;
            if (!isSchemaEmpty(poll.sessionMeta)) {
              setMeta(poll.sessionMeta);
              lastFetchedAtRef.current = Date.now();
              break;
            }
          } catch {
            // Network blip during polling — swallow and keep waiting.
            // The ensure itself already succeeded, so this is purely
            // about catching the late agent push.
          }
        }
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (isCurrent()) setLoading(false);
      loadingRef.current = false;
    }
  }, [threadId, canvasId, bindingKind, profileId, enabled]);

  const refreshIfStale = useCallback(
    (ttlMs: number = STALE_TTL_MS) => {
      if (loadingRef.current) return;
      const last = lastFetchedAtRef.current;
      if (last > 0 && Date.now() - last < ttlMs) return;
      void refresh();
    },
    [refresh],
  );

  const applyEvent = useCallback((event: AcpSessionMetaEvent) => {
    setMeta((prev) => {
      switch (event.type) {
        case 'session_mode_update': {
          const sameId = event.data.currentModeId === prev.currentModeId;
          const incomingModes = event.data.availableModes;
          // No-op only when the id matches AND no new mode catalogue
          // is being delivered (a partial `current_mode_update` push).
          if (sameId && !incomingModes) return prev;
          return {
            ...prev,
            currentModeId: event.data.currentModeId,
            ...(incomingModes ? { availableModes: incomingModes } : {}),
            updatedAt: Date.now(),
          };
        }
        case 'config_options_update': {
          const next = event.data.options;
          // Replace-by-id merge: a partial push (single option) only
          // overwrites that option; a full snapshot (Copilot's
          // typical 4-option push) overwrites everything by virtue of
          // covering every id already present.
          const byId = new Map(
            prev.configOptions.map((o) => [
              String((o as { id: string }).id),
              o,
            ]),
          );
          for (const opt of next) {
            const id = String((opt as { id?: unknown }).id ?? '');
            if (!id) continue;
            byId.set(id, opt);
          }
          return {
            ...prev,
            configOptions: Array.from(byId.values()),
            updatedAt: Date.now(),
          };
        }
        case 'session_info_update': {
          const prior = prev.sessionInfo ?? { title: null, updatedAt: null };
          return {
            ...prev,
            sessionInfo: {
              title:
                event.data.title === undefined ? prior.title : event.data.title,
              updatedAt:
                event.data.updatedAt === undefined
                  ? prior.updatedAt
                  : event.data.updatedAt,
            },
            updatedAt: Date.now(),
          };
        }
        case 'session_usage_update': {
          return {
            ...prev,
            usage: {
              used: event.data.used,
              size: event.data.size,
              cost: event.data.cost ?? null,
            },
            updatedAt: Date.now(),
          };
        }
        default:
          return prev;
      }
    });
  }, []);

  const applyOptimistic = useCallback(
    (patch: AcpSessionMetaOptimisticPatch) => {
      const selection = patch.selection;
      if (!selection) return;
      setMeta((prev) => {
        const prior = prev.selections[selection.id];
        if (selection.value === null) {
          if (!(selection.id in prev.selections)) return prev;
          const selections = { ...prev.selections };
          delete selections[selection.id];
          return { ...prev, selections, updatedAt: Date.now() };
        }
        if (prior === selection.value) return prev;
        return {
          ...prev,
          selections: { ...prev.selections, [selection.id]: selection.value },
          updatedAt: Date.now(),
        };
      });
    },
    [],
  );

  // Reset meta when binding/thread/canvas changes, then fire a
  // no-spawn cache hydrate so the selector dropdowns can populate
  // immediately from the server's last-known snapshot.
  //
  // Why split this from `refresh`: `refresh` triggers `ensureAcpSession`
  // (which spawns / resumes the agent), whereas this cache hydrate hits
  // the read-only `/cached-meta` endpoint and never spawns — so opening
  // a thread populates the toolbar without paying the cold-start tax.
  //
  // Server-side `/cached-meta` checks three tiers in order:
  //   1. live registry entry (in-memory),
  //   2. per-thread disk record (`session-store`),
  //   3. per-profile schema cache (shared across all threads of the
  //      same profile) — passing `profileId` enables this tier.
  //
  // If ANY tier hits we commit the snapshot and stop: 0 spawn, badge
  // stays optimistic-green, and the toolbar populates instantly.
  //
  // **Total miss → optional one-shot auto-ensure**: command Profiles
  // chain into `refresh()`. Manifest Profiles wait for their first real
  // turn because only the unified Profile driver can resolve and launch
  // their prepared deployment.
  //
  // Cache fetch never touches `loading` (which remains semantically
  // "real ensure in flight"), and never touches `error` (cache misses
  // are normal). `refresh` is read through a ref so this effect
  // doesn't re-fire just because the callback identity changed.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const myEpoch = ++epochRef.current;
    const isCurrent = () => epochRef.current === myEpoch;
    setMeta(EMPTY_META);
    setError(null);
    lastFetchedAtRef.current = 0;

    if (!threadId || bindingKind !== 'external' || !enabled) return;

    void getAcpThreadCachedMeta(
      threadId,
      canvasId ?? undefined,
      profileId || undefined,
    )
      .then((res) => {
        if (!isCurrent()) return;
        if (res.sessionMeta.updatedAt > 0) {
          // Cache hit (any tier) — commit and stop. Toolbar populated,
          // badge stays optimistic-green, no spawn.
          setMeta(res.sessionMeta);
          lastFetchedAtRef.current = Date.now();
          return;
        }
        // Total miss — fire a real ensure so the toolbar fills in
        // and the badge transitions through `connecting`. This now
        // only triggers on the very first thread of a profile (and
        // after a data-dir wipe).
        if (autoEnsureOnCacheMiss) void refreshRef.current();
      })
      .catch(() => {
        // Cache fetch itself failed (network / 5xx). Treat as cache
        // miss and try to ensure — that's the only path that can
        // actually surface a real failure to the user via the badge.
        if (!isCurrent()) return;
        if (autoEnsureOnCacheMiss) void refreshRef.current();
      });
  }, [
    threadId,
    bindingKind,
    profileId,
    canvasId,
    enabled,
    autoEnsureOnCacheMiss,
  ]);

  // Register `applyEvent` as the module-level SSE sink so
  // `handleStreamEvent` can forward session-meta updates here without
  // threading callbacks through every layer. The sink is a singleton
  // last-writer-wins (only one ChatPanel mounts at a time); always
  // clear it on unmount so headless reconnect / tests don't leak
  // into a stale hook instance.
  useEffect(() => {
    if (bindingKind !== 'external') return;
    setAcpSessionMetaSink(applyEvent);
    return () => setAcpSessionMetaSink(null);
  }, [bindingKind, applyEvent]);

  return {
    meta,
    loading,
    error,
    errorCode: deriveErrorCode(error),
    refresh,
    refreshIfStale,
    applyOptimistic,
  };
}

/**
 * Narrow an arbitrary thrown `error` into a categorical
 * {@link AcpEnsureErrorCode} when possible.
 *
 * The server (see `apps/server/src/modules/agent/acp/threads.route.ts`)
 * always sends `code` on the 503 body, and our HTTP client surfaces
 * it on {@link ApiError.code}. Anything that isn't a recognised code
 * (network failure, AbortError, future server-side additions we
 * don't know about yet) yields `null` so the consumer can fall back
 * to a generic message.
 */
const KNOWN_ENSURE_CODES: readonly AcpEnsureErrorCode[] = [
  'profile_missing',
  'bridge_not_mounted',
  'worker_not_ready',
  'placement_unavailable',
  'session_resume_unavailable',
  'spawn_failed',
  'connect_timeout',
  'internal',
];

function deriveErrorCode(err: Error | null): AcpEnsureErrorCode | null {
  if (!err) return null;
  if (!(err instanceof ApiError)) return null;
  const code = err.code;
  if (!code) return null;
  return (KNOWN_ENSURE_CODES as readonly string[]).includes(code)
    ? (code as AcpEnsureErrorCode)
    : null;
}
