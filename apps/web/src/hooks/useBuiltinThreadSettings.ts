// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-thread capability selection for the built-in (pi-ai) agent: fetches
 * the active provider's models (capability) and the thread's persisted
 * selection, and exposes optimistic setters that dispatch to the built-in
 * agent's per-thread settings endpoints.
 *
 * The **available** lists come from `GET /api/llm/models` (Huabu's own
 * capability); the **current** selection comes from the thread's durable
 * driver state via `GET /api/agent/threads/:id/settings`. This is the
 * "same UI, different data source" split from the external ACP path.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getChatThreadSettings,
  getLLMModels,
  setChatThreadModel,
  setChatThreadReasoningEffort,
} from '@/api/llm';
import { selectThreadSettings, useChatStore } from '@/store/chatStore';

import { createWorkspaceCache } from './workspaceCache';

import type { ChatThreadSettings, LLMModelInfo } from '@huabu/shared';

interface UseBuiltinThreadSettingsArgs {
  threadId: string | null | undefined;
  canvasId: string | null | undefined;
  /** The active provider id (models are scoped to it). */
  provider: string | null | undefined;
  /** The global default model id (the effective model when unset per-thread). */
  defaultModelId: string | null | undefined;
  /** Only fetch/operate for built-in threads. */
  enabled: boolean;
  /**
   * Whether the thread already has a persisted record (i.e. has run at
   * least one turn / has messages). Before that, the settings endpoints
   * have nothing to target, so a selection is only held locally and
   * carried on the first message — we skip the POST to avoid a 404.
   */
  threadHasMessages: boolean;
}

const EMPTY_SETTINGS: ChatThreadSettings = {
  modelId: null,
  reasoningEffort: null,
};

const STALE_TTL_MS = 10_000;

interface CachedProviderModelsEntry {
  models: LLMModelInfo[];
  fetchedAt: number;
}

interface CachedThreadSettingsEntry {
  settings: ChatThreadSettings;
  fetchedAt: number;
}

const useProviderModelsCache =
  createWorkspaceCache<CachedProviderModelsEntry>();
const useThreadSettingsCache =
  createWorkspaceCache<CachedThreadSettingsEntry>();

function threadSettingsCacheKey(
  canvasId: string | null | undefined,
  threadId: string | null | undefined,
): string | null {
  if (!threadId) return null;
  return JSON.stringify([canvasId ?? '', threadId]);
}

export function clearBuiltinThreadSettingsCache(): void {
  useProviderModelsCache.getState().clear();
  useThreadSettingsCache.getState().clear();
}

export function useBuiltinThreadSettings({
  threadId,
  canvasId,
  provider,
  defaultModelId,
  enabled,
  threadHasMessages,
}: UseBuiltinThreadSettingsArgs) {
  const providerModelsCache = useProviderModelsCache();
  const threadSettingsCache = useThreadSettingsCache();
  const { t } = useTranslation();
  const [models, setModels] = useState<LLMModelInfo[]>(() =>
    enabled && provider
      ? (providerModelsCache.get(provider)?.models ?? [])
      : [],
  );
  const cachedSettings = useChatStore((state) =>
    threadId ? selectThreadSettings(state, threadId) : EMPTY_SETTINGS,
  );
  const settings = enabled ? cachedSettings : EMPTY_SETTINGS;
  const setThreadSettings = useChatStore((state) => state.setThreadSettings);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // Bumped on every local user mutation. A settings fetch that started
  // before a mutation must not clobber the newer local value (P1-2).
  const mutationGenRef = useRef(0);
  const threadMessageStateRef = useRef({
    threadId: threadId ?? null,
    hasMessages: threadHasMessages,
  });

  // Fetch the active provider's model catalogue (capability + labels).
  useEffect(() => {
    if (!enabled || !provider) {
      setModels([]);
      return;
    }
    const cached = providerModelsCache.get(provider);
    if (cached) {
      setModels(cached.models);
      if (Date.now() - cached.fetchedAt < STALE_TTL_MS) {
        return;
      }
    } else {
      setModels([]);
    }
    let cancelled = false;
    void getLLMModels(provider)
      .then((next) => {
        if (
          !cancelled &&
          useProviderModelsCache.getState() === providerModelsCache
        ) {
          providerModelsCache.set(provider, {
            models: next,
            fetchedAt: Date.now(),
          });
          setModels(next);
        }
      })
      .catch(() => {
        if (!cancelled && !cached) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, provider, providerModelsCache]);

  // Fetch this thread's persisted selection.
  useEffect(() => {
    const previousMessageState = threadMessageStateRef.current;
    const isFirstMessageTransition =
      previousMessageState.threadId === threadId &&
      !previousMessageState.hasMessages &&
      threadHasMessages;
    threadMessageStateRef.current = {
      threadId: threadId ?? null,
      hasMessages: threadHasMessages,
    };

    if (!enabled || !threadId) {
      if (threadId) setThreadSettings(threadId, EMPTY_SETTINGS);
      setLoading(false);
      return;
    }
    // Sending the first message updates local history before the server has
    // necessarily persisted the deployment. The current thread already owns
    // the user's latest selection, so this lifecycle transition must not
    // trigger a stale settings reload.
    if (isFirstMessageTransition) {
      setLoading(false);
      return;
    }
    const settingsKey = threadSettingsCacheKey(canvasId, threadId);
    const cachedThread = settingsKey
      ? threadSettingsCache.get(settingsKey)
      : undefined;
    const restored =
      cachedThread?.settings ??
      selectThreadSettings(useChatStore.getState(), threadId);
    setThreadSettings(threadId, restored);
    // Before first send there is no durable server record. The local thread
    // cache is authoritative and is carried on the first message.
    if (!threadHasMessages) {
      setLoading(false);
      return;
    }
    if (cachedThread && Date.now() - cachedThread.fetchedAt < STALE_TTL_MS) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const genAtStart = mutationGenRef.current;
    if (!cachedThread) setLoading(true);
    void getChatThreadSettings(threadId, canvasId ?? undefined)
      .then((next) => {
        // Skip if the thread/enable changed, or the user picked a value
        // after this fetch started — the local choice wins (P1-2).
        if (
          cancelled ||
          mutationGenRef.current !== genAtStart ||
          useThreadSettingsCache.getState() !== threadSettingsCache ||
          (settingsKey && threadSettingsCache.get(settingsKey) !== cachedThread)
        )
          return;
        if (settingsKey) {
          threadSettingsCache.set(settingsKey, {
            settings: next,
            fetchedAt: Date.now(),
          });
        }
        setThreadSettings(threadId, next);
      })
      .catch(() => {
        // Keep the restored cache (or a local pick that bumped the generation).
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    threadId,
    canvasId,
    threadHasMessages,
    setThreadSettings,
    threadSettingsCache,
  ]);

  const selectSettings = useCallback(
    async (
      update: (current: ChatThreadSettings) => ChatThreadSettings,
      persist: (threadId: string) => Promise<ChatThreadSettings | void>,
    ): Promise<void> => {
      if (
        !enabled ||
        !threadId ||
        useThreadSettingsCache.getState() !== threadSettingsCache
      ) {
        throw new Error(t('chat.settingsUnavailable'));
      }
      if (savingRef.current) throw new Error(t('chat.settingsUpdatePending'));
      const settingsKey = threadSettingsCacheKey(canvasId, threadId);
      const previous = selectThreadSettings(useChatStore.getState(), threadId);
      mutationGenRef.current += 1;
      const nextSettings = update(previous);
      if (settingsKey) {
        threadSettingsCache.set(settingsKey, {
          settings: nextSettings,
          fetchedAt: Date.now(),
        });
      }
      setThreadSettings(threadId, nextSettings);
      if (!threadHasMessages) return;

      savingRef.current = true;
      setSaving(true);
      const applyResult = (settings: ChatThreadSettings) => {
        if (useThreadSettingsCache.getState() !== threadSettingsCache) return;
        if (settingsKey) {
          threadSettingsCache.set(settingsKey, {
            settings,
            fetchedAt: Date.now(),
          });
        }
        setThreadSettings(threadId, settings);
      };
      try {
        const corrected = await persist(threadId);
        if (corrected) applyResult(corrected);
      } catch (error) {
        // A timeout can still have committed remotely; the next GET reconciles it.
        applyResult(previous);
        throw error;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [
      canvasId,
      enabled,
      threadId,
      threadHasMessages,
      setThreadSettings,
      threadSettingsCache,
      t,
    ],
  );

  const selectModel = useCallback(
    (modelId: string) => {
      // Optimistic: adopt the model and drop an effort the new model can't
      // honour (off/absent stay), so the UI never shows a stale effort.
      const nextEfforts =
        models.find((m) => m.id === modelId)?.reasoningEfforts ?? [];
      return selectSettings(
        (current) => ({
          ...current,
          modelId,
          reasoningEffort:
            current.reasoningEffort &&
            current.reasoningEffort !== 'off' &&
            !nextEfforts.includes(current.reasoningEffort)
              ? null
              : current.reasoningEffort,
        }),
        (id) => setChatThreadModel(id, modelId, canvasId ?? undefined),
      );
    },
    [canvasId, models, selectSettings],
  );

  const selectReasoningEffort = useCallback(
    (reasoningEffort: string) =>
      selectSettings(
        (current) => ({ ...current, reasoningEffort }),
        async (id) => {
          await setChatThreadReasoningEffort(
            id,
            reasoningEffort,
            canvasId ?? undefined,
          );
        },
      ),
    [canvasId, selectSettings],
  );

  // The effective model id: the per-thread override, else the global default.
  const effectiveModelId = settings.modelId ?? defaultModelId ?? null;

  return {
    models,
    settings,
    effectiveModelId,
    loading,
    saving,
    selectModel,
    selectReasoningEffort,
  };
}
