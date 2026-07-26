/**
 * `AcpSessionSelectors` — the ACP-published mode / model / config-option
 * dropdowns rendered next to the NewChatMenu when the active thread
 * is delegated to an external agent that advertises any of those.
 *
 * Mirrors the four `session/update` variants Copilot CLI emits on
 * `session/new` (model / mode / thought-level / auto-approve toggle).
 * Selectors are hidden silently when their backing list is empty so
 * agents that publish nothing get no UI clutter.
 *
 * The modern `configOptions` channel is the source of truth: when an
 * agent publishes a `category: 'model'` / `'mode'` config option, its
 * clean picker replaces the legacy `availableModels` / `availableModes`
 * selector (which some agents, e.g. codex-acp, flatten into base × effort
 * combinations — microsoft/Huabu#31). Legacy lists render only as a
 * fallback for agents that publish no configOptions twin.
 *
 * All `onChange` handlers fire optimistically: the parent merges the
 * value into the local snapshot via `applyEvent` before the server
 * round-trip resolves, so the dropdown reflects the new choice
 * immediately. A `502` from the agent surfaces as a thrown error the
 * parent can choose to revert on.
 */

import { TriangleAlert } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  isModeConfigOption,
  isModelConfigOption,
} from './acpSessionConfigOption';
import { SessionSelectorPill } from './SessionSelectorPill';
import { Button } from '../../Common/Button';
import { Loading } from '../../Common/Loading';
import { Popover } from '../../Common/Popover';

import type { SelectOption } from '../../Common/Select';
import type {
  AcpSessionConfigOption,
  AcpSessionMetaSnapshot,
} from '@sediment/shared';

interface AcpSessionSelectorsProps {
  meta: AcpSessionMetaSnapshot;
  /**
   * Whether the parent thread is currently streaming. Selectors stay
   * interactive during a turn (mid-turn mode/model switches are a
   * supported ACP affordance), but consumers may opt into a disabled
   * variant by passing `true` here.
   */
  disabled?: boolean;
  /**
   * True while the initial session-meta fetch is in-flight (covers
   * both the `session/new` round-trip and the late-push retry).
   * Used to swap the empty render for a placeholder pill so the
   * toolbar gives the user feedback that selectors are still on the
   * way instead of looking inert.
   */
  loading?: boolean;
  onSelectMode: (modeId: string) => void | Promise<void>;
  onSelectModel: (modelId: string) => void | Promise<void>;
  onSelectConfigOption: (
    optionId: string,
    value: string | boolean,
  ) => void | Promise<void>;
}

/**
 * Render an `AcpSessionConfigOption` as a `Select`. Returns `null` for
 * options whose `type` we can't map to a dropdown (defensive — the
 * SDK union shouldn't surface anything else, but we'd rather drop
 * unknown shapes than crash).
 *
 * SDK shape recap (see `@agentclientprotocol/sdk` zod schema):
 *   • Both kinds share: `id`, `name`, optional `description`/`category`.
 *   • Select kind:  `type: 'select', currentValue: string, options: [{ name, value, description? } | { group, name, options: [...] }]`
 *   • Boolean kind: `type: 'boolean', currentValue: boolean`
 */
function ConfigOptionSelect({
  option,
  disabled,
  onSelect,
}: {
  option: AcpSessionConfigOption;
  disabled: boolean;
  onSelect: (value: string | boolean) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const id = String((option as { id?: unknown }).id ?? '');
  const label = String(
    (option as { name?: unknown }).name ??
      (option as { label?: unknown }).label ??
      id,
  );
  const type =
    (option as { type?: unknown }).type ?? (option as { kind?: unknown }).kind;

  // ── Boolean ──────────────────────────────────────────────────────
  if (type === 'boolean') {
    const current = Boolean(
      (option as { currentValue?: unknown }).currentValue,
    );
    const options: SelectOption<'true' | 'false'>[] = [
      { value: 'true', label: t('chat.on') },
      { value: 'false', label: t('chat.off') },
    ];
    return (
      <SessionSelectorPill<'true' | 'false'>
        options={options}
        value={current ? 'true' : 'false'}
        onChange={(next) => void onSelect(next === 'true')}
        disabled={disabled}
        title={label}
      />
    );
  }

  // ── Select (enum) ────────────────────────────────────────────────
  // Accept either the SDK shape (`options: [{name, value, ...}]`) or
  // a legacy `values: [...]` shape some forks emit. Group entries
  // (with a `group` field nesting their own `options`) get flattened
  // with a `sectionLabel`.
  const rawOptions =
    (option as { options?: unknown }).options ??
    (option as { values?: unknown }).values;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null;

  const flat: SelectOption<string>[] = [];
  for (const entry of rawOptions) {
    if (typeof entry === 'string') {
      flat.push({ value: entry, label: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    // Group: { group, name, options: [...] }
    if (Array.isArray(e.options) && typeof e.name === 'string') {
      const groupLabel = e.name;
      let isFirst = true;
      for (const sub of e.options as unknown[]) {
        if (!sub || typeof sub !== 'object') continue;
        const s = sub as Record<string, unknown>;
        const value = String(s.value ?? s.id ?? '');
        if (!value) continue;
        const subLabel = String(s.name ?? s.label ?? value);
        const desc = s.description;
        flat.push({
          value,
          label: subLabel,
          ...(isFirst ? { sectionLabel: groupLabel } : {}),
          ...(typeof desc === 'string' ? { description: desc } : {}),
        });
        isFirst = false;
      }
      continue;
    }
    // Flat: { name/label, value/id, description? }
    const value = String(e.value ?? e.id ?? '');
    if (!value) continue;
    const subLabel = String(e.name ?? e.label ?? value);
    const desc = e.description;
    flat.push({
      value,
      label: subLabel,
      ...(typeof desc === 'string' ? { description: desc } : {}),
    });
  }

  if (flat.length === 0) return null;
  const currentValue = String(
    (option as { currentValue?: unknown }).currentValue ?? '',
  );
  // If the agent hasn't reported a currentValue yet (initial publish
  // can race the seed), fall back to the first option so the trigger
  // shows something meaningful instead of an empty pill.
  const value = currentValue || flat[0].value;

  return (
    <SessionSelectorPill<string>
      options={flat}
      value={value}
      onChange={(next) => void onSelect(next)}
      disabled={disabled}
      title={label}
    />
  );
}

export const AcpSessionSelectors = ({
  meta,
  disabled = false,
  loading = false,
  onSelectMode,
  onSelectModel,
  onSelectConfigOption,
}: AcpSessionSelectorsProps) => {
  const { t } = useTranslation();
  const [pendingFullAccess, setPendingFullAccess] = useState<{
    optionId: string;
    value: string;
    position: { x: number; y: number };
  } | null>(null);
  const selectorRowRef = useRef<HTMLDivElement>(null);
  const fullAccessOriginRef = useRef<HTMLElement | null>(null);
  const fullAccessTitleId = useId();
  const fullAccessDescriptionId = useId();

  const dismissFullAccess = () => {
    setPendingFullAccess(null);
    window.setTimeout(() => fullAccessOriginRef.current?.focus(), 0);
  };
  // ── Mode selector ────────────────────────────────────────────────
  const modeOptions = useMemo<SelectOption<string>[]>(
    () =>
      meta.availableModes.map((m) => {
        const id = String((m as { id?: unknown }).id ?? '');
        const name = String((m as { name?: unknown }).name ?? id);
        const desc = (m as { description?: unknown }).description;
        return {
          value: id,
          label: name,
          ...(typeof desc === 'string' ? { description: desc } : {}),
        };
      }),
    [meta.availableModes],
  );

  // ── Model selector ───────────────────────────────────────────────
  const modelOptions = useMemo<SelectOption<string>[]>(
    () =>
      meta.availableModels.map((m) => {
        const id = String((m as { modelId?: unknown }).modelId ?? '');
        const name = String((m as { name?: unknown }).name ?? id);
        const desc = (m as { description?: unknown }).description;
        return {
          value: id,
          label: name,
          ...(typeof desc === 'string' ? { description: desc } : {}),
        };
      }),
    [meta.availableModels],
  );

  const hasMode = modeOptions.length > 0;
  const hasModel = modelOptions.length > 0;

  // Prefer the modern `configOptions` channel over the legacy
  // `availableModes` / `availableModels` lists. Agents such as codex-acp
  // publish BOTH, but their legacy model list flattens every base model ×
  // reasoning effort ("GPT-5.6 Sol (low)" … "(ultra)") and duplicates the
  // reasoning control, whereas the configOptions channel exposes a clean
  // base-model picker plus a separate `thought_level` (reasoning) control
  // and the Plan / Fast knobs (microsoft/Huabu#31). So when a modern twin
  // exists we hide the legacy selector and render the config option
  // instead; the legacy list is used only as a fallback for agents that
  // publish modes/models but no configOptions twin. Detection is by
  // semantic `category` ('model' / 'mode') with an id fallback, so it
  // works regardless of the agent's option-id naming.
  const hasModelConfigOption = useMemo(
    () => meta.configOptions.some(isModelConfigOption),
    [meta.configOptions],
  );
  const hasModeConfigOption = useMemo(
    () => meta.configOptions.some(isModeConfigOption),
    [meta.configOptions],
  );

  const showLegacyMode = hasMode && !hasModeConfigOption;
  const showLegacyModel = hasModel && !hasModelConfigOption;
  const hasConfig = meta.configOptions.length > 0;

  // Initial fetch in-flight and no data merged yet — show a single
  // unobtrusive placeholder pill so the toolbar signals that the
  // agent's selectors are still loading instead of looking inert.
  // Once any selector is renderable we drop the placeholder, even if
  // a follow-up refresh is still pending, to avoid layout jitter.
  if (!showLegacyMode && !showLegacyModel && !hasConfig) {
    if (loading) {
      return (
        <span
          role="status"
          aria-live="polite"
          aria-label={t('chat.loadingAgentOptions')}
          className="text-fg-subtle inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap"
        >
          <Loading layout="inline" size="xs" />
          <span>{t('chat.loadingAgentOptionsProgress')}</span>
        </span>
      );
    }
    return null;
  }

  return (
    <>
      <div
        ref={selectorRowRef}
        className="flex min-w-0 shrink items-center overflow-hidden"
      >
        {showLegacyMode && (
          <SessionSelectorPill<string>
            options={modeOptions}
            value={meta.currentModeId ?? modeOptions[0].value}
            onChange={(next) => void onSelectMode(next)}
            disabled={disabled}
            title={t('chat.agentMode')}
          />
        )}
        {showLegacyModel && (
          <SessionSelectorPill<string>
            options={modelOptions}
            value={meta.currentModelId ?? modelOptions[0].value}
            onChange={(next) => void onSelectModel(next)}
            disabled={disabled}
            title={t('chat.model')}
          />
        )}
        {meta.configOptions.map((opt) => {
          const id = String((opt as { id?: unknown }).id ?? '');
          if (!id) return null;
          return (
            <ConfigOptionSelect
              key={id}
              option={opt}
              disabled={disabled}
              onSelect={(value) => {
                if (isModeConfigOption(opt) && value === 'agent-full-access') {
                  const selectorRow = selectorRowRef.current;
                  const chatInputSurface = selectorRow?.closest(
                    '[data-chat-input-surface]',
                  );
                  const rect = (
                    chatInputSurface ?? selectorRow
                  )?.getBoundingClientRect();
                  fullAccessOriginRef.current =
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null;
                  setPendingFullAccess({
                    optionId: id,
                    value,
                    position: rect
                      ? { x: rect.left, y: rect.top }
                      : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
                  });
                  return;
                }
                return onSelectConfigOption(id, value);
              }}
            />
          );
        })}
      </div>
      {pendingFullAccess && (
        <Popover
          position={pendingFullAccess.position}
          anchor="bottom-left"
          offset={{ x: 0, y: -8 }}
          onDismiss={dismissFullAccess}
          className="w-80 max-w-[calc(100vw-1.5rem)] p-4"
        >
          <div
            role="alertdialog"
            aria-labelledby={fullAccessTitleId}
            aria-describedby={fullAccessDescriptionId}
          >
            <div className="flex items-start gap-2.5">
              <TriangleAlert
                aria-hidden="true"
                className="text-warning mt-0.5 h-4 w-4 shrink-0"
              />
              <div className="min-w-0">
                <h3
                  id={fullAccessTitleId}
                  className="text-fg-default text-sm font-semibold"
                >
                  {t('chat.fullAccessConfirmTitle')}
                </h3>
                <p
                  id={fullAccessDescriptionId}
                  className="text-fg-muted mt-1 text-xs leading-5"
                >
                  {t('chat.fullAccessConfirmDescription')}
                </p>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                autoFocus
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={dismissFullAccess}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                variant="solid"
                tone="danger"
                size="sm"
                onClick={() => {
                  const { optionId, value } = pendingFullAccess;
                  setPendingFullAccess(null);
                  void onSelectConfigOption(optionId, value);
                }}
              >
                {t('chat.enableFullAccess')}
              </Button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
};
