// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-thread capability selectors for the **built-in** (pi-ai) agent — the
 * built-in counterpart of {@link AcpSessionSelectors}. Renders the same pill
 * row, but its data source is Huabu's own normalized model capability
 * (`LLMModelInfo.reasoningEfforts`) rather than an external agent's
 * `configOptions`. See docs/proposals/chat-session-capability-controls.md.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { SessionSelectorPill } from './SessionSelectorPill';

import type { SelectOption } from '../../Common/Select';
import type { LLMModelInfo } from '@huabu/shared';

interface BuiltinSessionSelectorsProps {
  /** The active provider's models (capability + labels). */
  models: LLMModelInfo[];
  /** The effective model id for this thread (override, else global default). */
  currentModelId: string | null;
  /** The effective reasoning effort for this thread, or `null`. */
  currentReasoningEffort: string | null;
  /** Whether the selectors should be non-interactive. */
  disabled?: boolean;
  /** True while the initial models / settings fetch is in-flight. */
  loading?: boolean;
  onSelectModel: (modelId: string) => void | Promise<void>;
  onSelectReasoningEffort: (effort: string) => void | Promise<void>;
}

export function BuiltinSessionSelectors({
  models,
  currentModelId,
  currentReasoningEffort,
  disabled = false,
  loading = false,
  onSelectModel,
  onSelectReasoningEffort,
}: BuiltinSessionSelectorsProps) {
  const { t } = useTranslation();

  const modelOptions = useMemo<SelectOption<string>[]>(
    () => models.map((m) => ({ value: m.id, label: m.name })),
    [models],
  );

  const currentModel = useMemo(
    () => models.find((m) => m.id === currentModelId) ?? null,
    [models, currentModelId],
  );

  // Explicit "Auto" first: the model default (pi maps it to no reasoning
  // effort). Shown when nothing is picked, so the pill never looks empty.
  const effortOptions = useMemo<SelectOption<string>[]>(() => {
    const efforts = currentModel?.reasoningEfforts ?? [];
    if (efforts.length === 0) return [];
    return [
      { value: 'off', label: t('chat.effort.auto') },
      ...efforts.map((effort) => ({
        value: effort,
        label: t(`chat.effort.${effort}`, effort),
      })),
    ];
  }, [currentModel, t]);

  // Hidden-when-empty, mirroring AcpSessionSelectors: nothing to pick before
  // the model list has loaded, or when the active provider exposes none.
  if (loading && models.length === 0) return null;
  if (modelOptions.length === 0) return null;

  return (
    <>
      <SessionSelectorPill<string>
        options={modelOptions}
        value={currentModelId ?? ''}
        onChange={(next) => void onSelectModel(next)}
        disabled={disabled}
        title={t('chat.model')}
      />
      {effortOptions.length > 0 ? (
        <SessionSelectorPill<string>
          options={effortOptions}
          value={currentReasoningEffort ?? 'off'}
          onChange={(next) => void onSelectReasoningEffort(next)}
          disabled={disabled}
          title={t('chat.reasoningEffort')}
        />
      ) : null}
    </>
  );
}
