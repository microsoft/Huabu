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
import { useChatStore } from '@/store/chatStore';

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
  const [settings, setSettings] = useState<ChatThreadSettings>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  // Bumped on every local user mutation. A settings fetch that started
  // before a mutation must not clobber the newer local value (P1-2).
  const mutationGenRef = useRef(0);

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
    if (!enabled || !threadId) {
      setSettings(EMPTY_SETTINGS);
      return;
    }
    // Clear the previous thread's selection immediately so the load window
    // never carries a stale value into the newly-selected thread (P1-1).
    setSettings(EMPTY_SETTINGS);
    let cancelled = false;
    const genAtStart = mutationGenRef.current;
    setLoading(true);
    void getChatThreadSettings(threadId, canvasId ?? undefined)
      .then((next) => {
        // Skip if the thread/enable changed, or the user picked a value
        // after this fetch started — the local choice wins (P1-2).
        if (cancelled || mutationGenRef.current !== genAtStart) return;
        setSettings(next);
      })
      .catch(() => {
        // Keep EMPTY (or a local pick that bumped the generation).
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, threadId, canvasId]);

  // Mirror the current selection into the chat store so the send path can
  // carry it on the request (applies a pre-first-message pick on thread
  // creation). Tagged with `threadId` so the send only uses it for the
  // matching thread. Cleared for external bindings.
  const setChatSettings = useChatStore((s) => s.setChatSettings);
  useEffect(() => {
    setChatSettings(
      enabled && threadId
        ? {
            threadId,
            modelId: settings.modelId,
            reasoningEffort: settings.reasoningEffort,
          }
        : { threadId: null, modelId: null, reasoningEffort: null },
    );
  }, [enabled, threadId, settings, setChatSettings]);

  const selectModel = useCallback(
    async (modelId: string) => {
      if (!threadId) return;
      mutationGenRef.current += 1; // local choice beats any in-flight GET
      const gen = mutationGenRef.current;
      // Optimistic: adopt the model and drop an effort the new model can't
      // honour (off/absent stay), so the UI never shows a stale effort.
      const nextEfforts =
        models.find((m) => m.id === modelId)?.reasoningEfforts ?? [];
      setSettings((s) => ({
        ...s,
        modelId,
        reasoningEffort:
          s.reasoningEffort &&
          s.reasoningEffort !== 'off' &&
          !nextEfforts.includes(s.reasoningEffort)
            ? null
            : s.reasoningEffort,
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
        if (mutationGenRef.current === gen) setSettings(corrected);
      } catch {
        // Keep the optimistic value; a genuinely bad value is corrected by
        // the next settings fetch.
      }
    },
    [threadId, canvasId, threadHasMessages, models],
  );

  const selectReasoningEffort = useCallback(
    async (reasoningEffort: string) => {
      if (!threadId) return;
      mutationGenRef.current += 1;
      setSettings((s) => ({ ...s, reasoningEffort })); // optimistic
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
    [threadId, canvasId, threadHasMessages],
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
