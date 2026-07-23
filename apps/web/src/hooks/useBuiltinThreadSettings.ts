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

import { useCallback, useEffect, useState } from 'react';

import {
  getChatThreadSettings,
  getLLMModels,
  setChatThreadModel,
  setChatThreadReasoningEffort,
} from '@/api/llm';
import { useChatStore } from '@/store/chatStore';

import type { ChatThreadSettings, LLMModelInfo } from '@sediment/shared';

interface UseBuiltinThreadSettingsArgs {
  threadId: string | null | undefined;
  canvasId: string | null | undefined;
  /** The active provider id (models are scoped to it). */
  provider: string | null | undefined;
  /** The global default model id (the effective model when unset per-thread). */
  defaultModelId: string | null | undefined;
  /** Only fetch/operate for built-in threads. */
  enabled: boolean;
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
}: UseBuiltinThreadSettingsArgs) {
  const [models, setModels] = useState<LLMModelInfo[]>([]);
  const [settings, setSettings] = useState<ChatThreadSettings>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);

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
    let cancelled = false;
    setLoading(true);
    void getChatThreadSettings(threadId, canvasId ?? undefined)
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => {
        if (!cancelled) setSettings(EMPTY_SETTINGS);
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
  // creation). Cleared for external bindings.
  const setChatSettings = useChatStore((s) => s.setChatSettings);
  useEffect(() => {
    setChatSettings(
      enabled ? settings : { modelId: null, reasoningEffort: null },
    );
  }, [enabled, settings, setChatSettings]);

  const selectModel = useCallback(
    async (modelId: string) => {
      if (!threadId) return;
      setSettings((s) => ({ ...s, modelId })); // optimistic
      try {
        await setChatThreadModel(threadId, modelId, canvasId ?? undefined);
      } catch {
        // Keep the optimistic value: before the thread's first message the
        // endpoint 404s (no record yet), and the selection is carried on
        // the first message instead. A genuinely bad value is corrected by
        // the next settings fetch.
      }
    },
    [threadId, canvasId],
  );

  const selectReasoningEffort = useCallback(
    async (reasoningEffort: string) => {
      if (!threadId) return;
      setSettings((s) => ({ ...s, reasoningEffort })); // optimistic
      try {
        await setChatThreadReasoningEffort(
          threadId,
          reasoningEffort,
          canvasId ?? undefined,
        );
      } catch {
        // See selectModel: keep the optimistic value; carried on first send.
      }
    },
    [threadId, canvasId],
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
