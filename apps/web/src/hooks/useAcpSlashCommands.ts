// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';

import { getAcpThreadCachedMeta } from '@/api/acp';

import type { AgentBinding, AvailableCommand } from '@huabu/shared';

const STALE_TTL_MS = 10_000;
const EMPTY_RETRY_TTL_MS = 1_500;

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
 * Mount and slash-menu refreshes are GET-only. A cache miss is a normal empty
 * result and never creates a workload or starts an ACP process.
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
  const epochRef = useRef(0);
  const loadingRef = useRef(false);
  const lastFetchedAtRef = useRef(0);
  const invalidatePending = useCallback(() => {
    epochRef.current++;
  }, []);
  const bindingKind = binding.kind;
  const profileId = binding.kind === 'external' ? binding.profileId : '';

  const refresh = useCallback(async () => {
    const myEpoch = ++epochRef.current;
    const isCurrent = () => epochRef.current === myEpoch;

    if (!threadId || bindingKind !== 'external' || !enabled) {
      setCommands([]);
      setError(null);
      setLoading(false);
      loadingRef.current = false;
      return;
    }

    setLoading(true);
    loadingRef.current = true;
    try {
      const response = await getAcpThreadCachedMeta(
        threadId,
        canvasId ?? undefined,
        profileId,
      );
      if (!isCurrent()) return;
      setCommands(response.availableCommands);
      setError(null);
      lastFetchedAtRef.current = Date.now();
    } catch (value) {
      if (!isCurrent()) return;
      setError(value instanceof Error ? value : new Error(String(value)));
    } finally {
      if (isCurrent()) setLoading(false);
      loadingRef.current = false;
    }
  }, [threadId, bindingKind, enabled, canvasId, profileId]);

  const refreshIfStale = useCallback(
    (ttlMs: number = STALE_TTL_MS) => {
      if (loadingRef.current) return;
      const lastFetchedAt = lastFetchedAtRef.current;
      const effectiveTtl =
        commands.length > 0 ? ttlMs : Math.min(ttlMs, EMPTY_RETRY_TTL_MS);
      if (lastFetchedAt > 0 && Date.now() - lastFetchedAt < effectiveTtl) {
        return;
      }
      void refresh();
    },
    [commands.length, refresh],
  );

  useEffect(() => {
    setCommands([]);
    setError(null);
    lastFetchedAtRef.current = 0;
    if (threadId && bindingKind === 'external' && enabled) void refresh();
    return invalidatePending;
  }, [threadId, bindingKind, profileId, enabled, refresh, invalidatePending]);

  return { commands, loading, error, refresh, refreshIfStale };
}
