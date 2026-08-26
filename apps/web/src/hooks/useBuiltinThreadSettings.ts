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

import {
  getChatThreadSettings,
  getLLMModels,
  setChatThreadModel,
  setChatThreadReasoningEffort,
} from '@/api/llm';
import { selectThreadSettings, useChatStore } from '@/store/chatStore';

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

export function useBuiltinThreadSettings({
  threadId,
  canvasId,
  provider,
  defaultModelId,
  enabled,
  threadHasMessages,
}: UseBuiltinThreadSettingsArgs) {
  const [models, setModels] = useState<LLMModelInfo[]>([]);
  const [settingsState, setSettingsState] = useState<{
    threadId: string | null;
    settings: ChatThreadSettings;
  }>(() => ({
    threadId: threadId ?? null,
    settings:
      enabled && threadId
        ? selectThreadSettings(useChatStore.getState(), threadId)
        : EMPTY_SETTINGS,
  }));
  const settingsStateRef = useRef(settingsState);
  const replaceSettingsState = useCallback(
    (next: { threadId: string | null; settings: ChatThreadSettings }) => {
      settingsStateRef.current = next;
      setSettingsState(next);
    },
    [],
  );
  const cachedSettings = useChatStore((state) =>
    threadId ? selectThreadSettings(state, threadId) : EMPTY_SETTINGS,
  );
  const settings =
    enabled && settingsState.threadId === threadId
      ? settingsState.settings
      : enabled
        ? cachedSettings
        : EMPTY_SETTINGS;
  const [loading, setLoading] = useState(false);
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
    let cancelled = false;
    void getLLMModels(provider)
      .then((next) => {
        if (!cancelled) setModels(next);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, provider]);

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
      replaceSettingsState({
        threadId: threadId ?? null,
        settings: EMPTY_SETTINGS,
      });
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
    const restored = selectThreadSettings(useChatStore.getState(), threadId);
    replaceSettingsState({ threadId, settings: restored });
    // Before first send there is no durable server record. The local thread
    // cache is authoritative and is carried on the first message.
    if (!threadHasMessages) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const genAtStart = mutationGenRef.current;
    setLoading(true);
    void getChatThreadSettings(threadId, canvasId ?? undefined)
      .then((next) => {
        // Skip if the thread/enable changed, or the user picked a value
        // after this fetch started — the local choice wins (P1-2).
        if (cancelled || mutationGenRef.current !== genAtStart) return;
        replaceSettingsState({ threadId, settings: next });
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
  }, [enabled, threadId, canvasId, threadHasMessages, replaceSettingsState]);

  // Mirror the current selection into the owning thread so the send path can
  // carry it on the request (applies a pre-first-message pick on thread
  // creation). Cleared for external bindings.
  const setThreadSettings = useChatStore((s) => s.setThreadSettings);
  useEffect(() => {
    if (!threadId) return;
    setThreadSettings(
      threadId,
      enabled
        ? {
            modelId: settings.modelId,
            reasoningEffort: settings.reasoningEffort,
          }
        : { modelId: null, reasoningEffort: null },
    );
  }, [enabled, threadId, settings, setThreadSettings]);

  const updateLocalSettings = useCallback(
    (
      update: (current: ChatThreadSettings) => ChatThreadSettings,
    ): ChatThreadSettings | null => {
      if (!threadId) return null;
      const current = settingsStateRef.current;
      const previous =
        current.threadId === threadId
          ? current.settings
          : selectThreadSettings(useChatStore.getState(), threadId);
      const nextSettings = update(previous);
      replaceSettingsState({ threadId, settings: nextSettings });
      setThreadSettings(threadId, nextSettings);
      return nextSettings;
    },
    [threadId, replaceSettingsState, setThreadSettings],
  );

  const selectModel = useCallback(
    async (modelId: string) => {
      if (!threadId) return;
      mutationGenRef.current += 1; // local choice beats any in-flight GET
      const gen = mutationGenRef.current;
      // Optimistic: adopt the model and drop an effort the new model can't
      // honour (off/absent stay), so the UI never shows a stale effort.
      const nextEfforts =
        models.find((m) => m.id === modelId)?.reasoningEfforts ?? [];
      updateLocalSettings((current) => ({
        ...current,
        modelId,
        reasoningEffort:
          current.reasoningEffort &&
          current.reasoningEffort !== 'off' &&
          !nextEfforts.includes(current.reasoningEffort)
            ? null
            : current.reasoningEffort,
      }));
      // No persisted record yet → hold locally; the first message carries
      // it (skip the POST so nothing 404s).
      if (!threadHasMessages) return;
      try {
        const corrected = await setChatThreadModel(
          threadId,
          modelId,
          canvasId ?? undefined,
        );
        // Adopt the server's canonical (clamped) values, unless the user
        // changed something while the request was in flight.
        if (mutationGenRef.current === gen) {
          replaceSettingsState({ threadId, settings: corrected });
        }
      } catch {
        // Keep the optimistic value; a genuinely bad value is corrected by
        // the next settings fetch.
      }
    },
    [
      threadId,
      canvasId,
      threadHasMessages,
      models,
      updateLocalSettings,
      replaceSettingsState,
    ],
  );

  const selectReasoningEffort = useCallback(
    async (reasoningEffort: string) => {
      if (!threadId) return;
      mutationGenRef.current += 1;
      updateLocalSettings((current) => ({ ...current, reasoningEffort }));
      if (!threadHasMessages) return;
      try {
        await setChatThreadReasoningEffort(
          threadId,
          reasoningEffort,
          canvasId ?? undefined,
        );
      } catch {
        // Keep the optimistic value; carried on the next send.
      }
    },
    [threadId, canvasId, threadHasMessages, updateLocalSettings],
  );

  // The effective model id: the per-thread override, else the global default.
  const effectiveModelId = settings.modelId ?? defaultModelId ?? null;

  return {
    models,
    settings,
    effectiveModelId,
    loading,
    selectModel,
    selectReasoningEffort,
  };
}
