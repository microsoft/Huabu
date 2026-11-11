// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Reads thread/Profile capability observations through the GET-only cache
 * endpoint and merges live metadata events after a real interaction starts.
 * Cache misses discover Profile capabilities without realizing this thread.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getAcpThreadCachedMeta, loadAcpProfileCapabilities } from '@/api/acp';
import {
  registerAcpSessionMetaSink,
  type AcpSessionMetaStreamEvent,
} from '@/hooks/useAgentStream';
import { selectThreadIsLoading, useChatStore } from '@/store/chatStore';
import {
  observeConversationExecution,
  useConversationPreparationStore,
} from '@/store/conversationPreparation';

import { createWorkspaceCache } from './workspaceCache';

import type {
  AcpSessionMetaSnapshot,
  AcpThreadCachedMetaResponse,
  AgentBinding,
} from '@huabu/shared';

const STALE_TTL_MS = 10_000;

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

interface CachedAcpSessionMetaEntry {
  meta: AcpSessionMetaSnapshot;
  source: AcpThreadCachedMetaResponse['source'];
  fetchedAt: number;
}

const useSessionMetaCache = createWorkspaceCache<CachedAcpSessionMetaEntry>();

function sessionMetaCacheKey(
  canvasId: string | null | undefined,
  threadId: string | null | undefined,
  profileId: string,
): string | null {
  if (!threadId || !profileId) return null;
  return JSON.stringify([canvasId ?? '', threadId, profileId]);
}

export function clearAcpSessionMetaCache(): void {
  useSessionMetaCache.getState().clear();
}

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
  /** Whether the snapshot belongs to this thread or is a Profile observation. */
  source: AcpThreadCachedMetaResponse['source'];
  /** True while the initial snapshot is loading; warm refreshes stay silent. */
  loading: boolean;
  /** Last error from a fetch, or `null`. */
  error: Error | null;
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
}: UseAcpSessionMetaOptions): UseAcpSessionMetaResult {
  const sessionMetaCache = useSessionMetaCache();
  const bindingKind = binding.kind;
  const profileId = binding.kind === 'external' ? binding.profileId : '';
  const cacheKey =
    bindingKind === 'external' && enabled
      ? sessionMetaCacheKey(canvasId, threadId, profileId)
      : null;
  const initialCached = cacheKey ? sessionMetaCache.get(cacheKey) : undefined;

  const [meta, setMeta] = useState<AcpSessionMetaSnapshot>(
    () => initialCached?.meta ?? EMPTY_META,
  );
  const [source, setSource] = useState<AcpThreadCachedMetaResponse['source']>(
    () => initialCached?.source ?? 'none',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Monotonic epoch for cancellation; mirrors the pattern in
  // useAcpSlashCommands — see that file for the design rationale.
  const epochRef = useRef(0);
  const loadingRef = useRef(false);
  const lastFetchedAtRef = useRef(initialCached?.fetchedAt ?? 0);
  const invalidatePending = useCallback(() => {
    epochRef.current++;
    loadingRef.current = false;
  }, []);

  const isStreaming = useChatStore(
    (state) => !!threadId && selectThreadIsLoading(state, threadId),
  );
  const wasStreaming = useRef(false);

  const refresh = useCallback(async () => {
    const myEpoch = ++epochRef.current;
    const isCurrent = () =>
      epochRef.current === myEpoch &&
      useSessionMetaCache.getState() === sessionMetaCache;

    if (!threadId || bindingKind !== 'external' || !enabled || !cacheKey) {
      // Internal binding (or external binding whose precondition has
      // been gated off by the caller) — nothing to fetch. Reset to
      // empty so a freshly-switched internal binding doesn't keep
      // showing the previous agent's snapshot.
      setMeta(EMPTY_META);
      setSource('none');
      setError(null);
      setLoading(false);
      loadingRef.current = false;
      return;
    }

    const hasWarmMeta =
      (sessionMetaCache.get(cacheKey)?.meta.updatedAt ?? 0) > 0;
    if (!hasWarmMeta) setLoading(true);
    loadingRef.current = true;
    try {
      const preparationRevision =
        useConversationPreparationStore.getState().revisions[
          JSON.stringify([canvasId ?? '', threadId])
        ] ?? 0;
      let res = await getAcpThreadCachedMeta(
        threadId,
        canvasId ?? undefined,
        profileId,
      );
      if (!isCurrent()) return;
      observeConversationExecution(
        canvasId ?? '',
        threadId,
        res.execution,
        preparationRevision,
      );
      if (res.source !== 'thread' && res.sessionMeta.updatedAt === 0) {
        res = await loadAcpProfileCapabilities(profileId);
        if (!isCurrent()) return;
      }
      const fetchedAt = Date.now();
      sessionMetaCache.set(cacheKey, {
        meta: res.sessionMeta,
        source: res.source,
        fetchedAt,
      });
      setMeta(res.sessionMeta);
      setSource(res.source);
      setError(null);
      lastFetchedAtRef.current = fetchedAt;
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (isCurrent()) {
        setLoading(false);
        loadingRef.current = false;
      }
    }
  }, [
    threadId,
    canvasId,
    bindingKind,
    profileId,
    enabled,
    cacheKey,
    sessionMetaCache,
  ]);

  const refreshIfStale = useCallback(
    (ttlMs: number = STALE_TTL_MS) => {
      if (loadingRef.current) return;
      const last =
        (cacheKey ? sessionMetaCache.get(cacheKey)?.fetchedAt : undefined) ??
        lastFetchedAtRef.current;
      if (last > 0 && Date.now() - last < ttlMs) return;
      void refresh();
    },
    [cacheKey, refresh, sessionMetaCache],
  );

  const applyEvent = useCallback(
    (event: AcpSessionMetaEvent) => {
      if (useSessionMetaCache.getState() !== sessionMetaCache) return;
      epochRef.current++;
      loadingRef.current = false;
      setLoading(false);
      setError(null);
      setSource('thread');
      setMeta((prev) => {
        const nextMeta = ((): AcpSessionMetaSnapshot => {
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
              const prior = prev.sessionInfo ?? {
                title: null,
                updatedAt: null,
              };
              return {
                ...prev,
                sessionInfo: {
                  title:
                    event.data.title === undefined
                      ? prior.title
                      : event.data.title,
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
        })();
        if (cacheKey) {
          sessionMetaCache.set(cacheKey, {
            meta: nextMeta,
            source: 'thread',
            fetchedAt: Date.now(),
          });
        }
        return nextMeta;
      });
    },
    [cacheKey, sessionMetaCache],
  );

  const applyOptimistic = useCallback(
    (patch: AcpSessionMetaOptimisticPatch) => {
      if (useSessionMetaCache.getState() !== sessionMetaCache) return;
      const selection = patch.selection;
      if (!selection) return;
      setMeta((prev) => {
        const prior = prev.selections[selection.id];
        let nextMeta = prev;
        if (selection.value === null) {
          if (!(selection.id in prev.selections)) return prev;
          const selections = { ...prev.selections };
          delete selections[selection.id];
          nextMeta = { ...prev, selections, updatedAt: Date.now() };
        } else if (prior !== selection.value) {
          nextMeta = {
            ...prev,
            selections: {
              ...prev.selections,
              [selection.id]: selection.value,
            },
            updatedAt: Date.now(),
          };
        }
        if (nextMeta !== prev && cacheKey) {
          const existing = sessionMetaCache.get(cacheKey);
          sessionMetaCache.set(cacheKey, {
            meta: nextMeta,
            source: existing?.source ?? source,
            fetchedAt: existing?.fetchedAt ?? lastFetchedAtRef.current,
          });
        }
        return nextMeta;
      });
    },
    [cacheKey, source, sessionMetaCache],
  );

  useEffect(() => {
    const finished = wasStreaming.current && !isStreaming;
    wasStreaming.current = isStreaming;
    if (finished) void refresh();
  }, [isStreaming, refresh]);

  useEffect(() => {
    if (!cacheKey) {
      setMeta(EMPTY_META);
      setSource('none');
      setError(null);
      setLoading(false);
      lastFetchedAtRef.current = 0;
      return invalidatePending;
    }

    const cached = sessionMetaCache.get(cacheKey);

    if (cached) {
      setMeta(cached.meta);
      setSource(cached.source);
      setError(null);
      setLoading(false);
      lastFetchedAtRef.current = cached.fetchedAt;
      if (
        !loadingRef.current &&
        (Date.now() - cached.fetchedAt >= STALE_TTL_MS ||
          (!!threadId &&
            selectThreadIsLoading(useChatStore.getState(), threadId)))
      ) {
        void refresh();
      }
      return invalidatePending;
    }

    setMeta(EMPTY_META);
    setSource('none');
    setError(null);
    lastFetchedAtRef.current = 0;
    void refresh();
    return invalidatePending;
  }, [cacheKey, threadId, refresh, invalidatePending, sessionMetaCache]);

  useEffect(() => {
    if (!threadId || bindingKind !== 'external') return;
    const unregister = registerAcpSessionMetaSink(threadId, applyEvent);
    return () => {
      unregister();
      // Hidden panels miss stream metadata, including a final usage update.
      if (
        cacheKey &&
        selectThreadIsLoading(useChatStore.getState(), threadId)
      ) {
        const cached = sessionMetaCache.get(cacheKey);
        if (cached) sessionMetaCache.set(cacheKey, { ...cached, fetchedAt: 0 });
      }
    };
  }, [threadId, bindingKind, applyEvent, cacheKey, sessionMetaCache]);

  return {
    meta,
    source,
    loading,
    error,
    refresh,
    refreshIfStale,
    applyOptimistic,
  };
}
