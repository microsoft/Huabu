// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';

import { getAcpThreadCachedMeta, loadAcpProfileCapabilities } from '@/api/acp';

import { createWorkspaceCache } from './workspaceCache';

import type { AgentBinding, AvailableCommand } from '@huabu/shared';

const STALE_TTL_MS = 10_000;
const EMPTY_RETRY_TTL_MS = 1_500;

interface CachedAcpSlashCommandsEntry {
  commands: AvailableCommand[];
  fetchedAt: number;
}

const useSlashCommandsCache =
  createWorkspaceCache<CachedAcpSlashCommandsEntry>();

function slashCommandsCacheKey(
  canvasId: string | null | undefined,
  threadId: string | null | undefined,
  profileId: string,
): string | null {
  if (!threadId || !profileId) return null;
  return JSON.stringify([canvasId ?? '', threadId, profileId]);
}

export function clearAcpSlashCommandsCache(): void {
  useSlashCommandsCache.getState().clear();
}

export interface UseAcpSlashCommandsResult {
  commands: AvailableCommand[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  refreshIfStale: (ttlMs?: number) => void;
}

export interface UseAcpSlashCommandsOptions {
  threadId: string | null | undefined;
  binding: AgentBinding;
  canvasId?: string | null;
  enabled?: boolean;
}

/**
 * Read slash commands from the server-owned capability cache.
 *
 * A cache miss discovers Profile capabilities without realizing this thread.
 */
export function useAcpSlashCommands({
  threadId,
  binding,
  canvasId,
  enabled = true,
}: UseAcpSlashCommandsOptions): UseAcpSlashCommandsResult {
  const slashCommandsCache = useSlashCommandsCache();
  const bindingKind = binding.kind;
  const profileId = binding.kind === 'external' ? binding.profileId : '';
  const cacheKey =
    bindingKind === 'external' && enabled
      ? slashCommandsCacheKey(canvasId, threadId, profileId)
      : null;
  const initialCached = cacheKey ? slashCommandsCache.get(cacheKey) : undefined;

  const [commands, setCommands] = useState<AvailableCommand[]>(
    () => initialCached?.commands ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
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
      useSlashCommandsCache.getState() === slashCommandsCache;

    if (!threadId || bindingKind !== 'external' || !enabled || !cacheKey) {
      setCommands([]);
      setError(null);
      setLoading(false);
      loadingRef.current = false;
      return;
    }

    const hasWarmCommands = slashCommandsCache.has(cacheKey);
    if (!hasWarmCommands) setLoading(true);
    loadingRef.current = true;
    try {
      let response = await getAcpThreadCachedMeta(
        threadId,
        canvasId ?? undefined,
        profileId,
      );
      if (!isCurrent()) return;
      if (
        response.source !== 'thread' &&
        response.sessionMeta.updatedAt === 0
      ) {
        response = await loadAcpProfileCapabilities(profileId);
        if (!isCurrent()) return;
      }
      // `availableCommands` is dropped from the JSON body entirely when the
      // server's live session entry hasn't populated it yet, so `response`
      // can arrive without the field despite the response type saying
      // otherwise. Falling back to `[]` keeps `commands` an array so every
      // downstream `.length` read stays safe.
      const nextCommands = response.availableCommands ?? [];
      const fetchedAt = Date.now();
      slashCommandsCache.set(cacheKey, {
        commands: nextCommands,
        fetchedAt,
      });
      setCommands(nextCommands);
      setError(null);
      lastFetchedAtRef.current = fetchedAt;
    } catch (value) {
      if (!isCurrent()) return;
      setError(value instanceof Error ? value : new Error(String(value)));
    } finally {
      if (isCurrent()) {
        setLoading(false);
        loadingRef.current = false;
      }
    }
  }, [
    threadId,
    bindingKind,
    enabled,
    canvasId,
    profileId,
    cacheKey,
    slashCommandsCache,
  ]);

  const refreshIfStale = useCallback(
    (ttlMs: number = STALE_TTL_MS) => {
      if (loadingRef.current) return;
      const lastFetchedAt =
        (cacheKey ? slashCommandsCache.get(cacheKey)?.fetchedAt : undefined) ??
        lastFetchedAtRef.current;
      const effectiveTtl =
        commands.length > 0 ? ttlMs : Math.min(ttlMs, EMPTY_RETRY_TTL_MS);
      if (lastFetchedAt > 0 && Date.now() - lastFetchedAt < effectiveTtl) {
        return;
      }
      void refresh();
    },
    [cacheKey, commands.length, refresh, slashCommandsCache],
  );

  useEffect(() => {
    if (!cacheKey) {
      setCommands([]);
      setError(null);
      setLoading(false);
      lastFetchedAtRef.current = 0;
      return invalidatePending;
    }

    const cached = slashCommandsCache.get(cacheKey);

    if (cached) {
      setCommands(cached.commands);
      setError(null);
      setLoading(false);
      lastFetchedAtRef.current = cached.fetchedAt;
      const effectiveTtl =
        cached.commands.length > 0
          ? STALE_TTL_MS
          : Math.min(STALE_TTL_MS, EMPTY_RETRY_TTL_MS);
      if (Date.now() - cached.fetchedAt >= effectiveTtl) {
        void refresh();
      }
      return invalidatePending;
    }

    setCommands([]);
    setError(null);
    lastFetchedAtRef.current = 0;
    void refresh();
    return invalidatePending;
  }, [cacheKey, refresh, invalidatePending, slashCommandsCache]);

  return { commands, loading, error, refresh, refreshIfStale };
}
