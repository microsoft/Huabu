/**
 * `useAcpSessionMeta` — fetch and cache the agent-published session
 * metadata (modes / models / config options / info / usage) for the
 * active thread's external binding.
 *
 * Companion to {@link useAcpSlashCommands}: same lifecycle (bootstrap
 * + on-demand refresh, gated by an internal binding short-circuit),
 * but the data surface is the ChatPanel's mode/model/config selectors
 * rather than the slash-command typeahead.
 *
 * SSE integration: the consumer (typically `useAgentStream` host) can
 * call {@link UseAcpSessionMetaResult.applyEvent} on each incoming
 * `session_mode_update` / `config_options_update` / `session_info_update`
 * / `session_usage_update` event to merge it into the cached
 * snapshot WITHOUT a round-trip. This keeps the dropdowns live while
 * the turn is running.
 *
 * Errors are stored on `error` but never thrown — meta is a polish
 * surface; a failure should silently degrade to no selectors rather
 * than disrupt chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureAcpSession, getAcpThreadCommands } from '@/api/acp';
import {
  setAcpSessionMetaSink,
  type AcpSessionMetaStreamEvent,
} from '@/hooks/useAgentStream';

import type { AcpSessionMetaSnapshot, AgentBinding } from '@sediment/shared';

const RETRY_DELAY_MS = 200;
const STALE_TTL_MS = 10_000;

/** Empty snapshot used while no session has been opened. */
const EMPTY_META: AcpSessionMetaSnapshot = {
  availableModes: [],
  currentModeId: null,
  availableModels: [],
  currentModelId: null,
  configOptions: [],
  sessionInfo: null,
  usage: null,
  updatedAt: 0,
};

/** Subset of `AgentStreamEvent` types this hook merges into the snapshot. */
export type AcpSessionMetaEvent = AcpSessionMetaStreamEvent;

export interface UseAcpSessionMetaResult {
  /** Snapshot the server most recently confirmed. Never null. */
  meta: AcpSessionMetaSnapshot;
  /** True while ANY in-flight fetch is pending. */
  loading: boolean;
  /** Last error from a fetch, or `null`. */
  error: Error | null;
  /** Manual re-fetch. */
  refresh: () => Promise<void>;
  /** TTL-gated re-fetch (see file header). */
  refreshIfStale: (ttlMs?: number) => void;
  /**
   * Merge a `session_*_update` / `config_options_update` SSE event into
   * the snapshot. Safe to call from a render effect — performs a
   * shallow comparison and skips the state set when the event is a
   * no-op (e.g. duplicate id).
   */
  applyEvent: (event: AcpSessionMetaEvent) => void;
}

export interface UseAcpSessionMetaOptions {
  threadId: string | null | undefined;
  binding: AgentBinding;
  canvasId?: string | null;
}

/**
 * Subscribe to the session-meta snapshot for a thread bound to an
 * external agent. Internal bindings short-circuit to {@link EMPTY_META}.
 */
export function useAcpSessionMeta({
  threadId,
  binding,
  canvasId,
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
  const agentletAgentId =
    binding.kind === 'external' ? binding.agentletAgentId : '';
  const alias = binding.kind === 'external' ? binding.alias : '';

  const refresh = useCallback(async () => {
    const myEpoch = ++epochRef.current;
    const isCurrent = () => epochRef.current === myEpoch;

    if (!threadId || bindingKind !== 'external') {
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
        agentletAgentId,
        alias,
      });
      if (!isCurrent()) return;
      setMeta(res.sessionMeta);
      setError(null);
      lastFetchedAtRef.current = Date.now();

      // Same late-push retry as useAcpSlashCommands: agents typically
      // emit `config_option_update` / `current_mode_update` within
      // tens of ms after `session/new` resolves. One delayed GET
      // catches them without polling.
      if (res.sessionMeta.updatedAt === 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        if (!isCurrent()) return;
        const followup = await getAcpThreadCommands(threadId);
        if (!isCurrent()) return;
        if (followup) {
          setMeta(followup.sessionMeta);
          lastFetchedAtRef.current = Date.now();
        }
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (isCurrent()) setLoading(false);
      loadingRef.current = false;
    }
  }, [threadId, canvasId, bindingKind, agentletAgentId, alias]);

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

  useEffect(() => {
    setMeta(EMPTY_META);
    setError(null);
    void refresh();
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      epochRef.current++;
    };
  }, [refresh]);

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

  return { meta, loading, error, refresh, refreshIfStale, applyEvent };
}
