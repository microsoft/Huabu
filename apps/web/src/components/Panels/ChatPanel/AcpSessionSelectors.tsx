/**
 * `AcpSessionSelectors` — the ACP-published mode / model / config-option
 * dropdowns rendered next to the ModeSelector when the active thread
 * is delegated to an external agent that advertises any of those.
 *
 * Mirrors the four `session/update` variants Copilot CLI emits on
 * `session/new` (model / mode / thought-level / auto-approve toggle).
 * Selectors are hidden silently when their backing list is empty so
 * agents that publish nothing get no UI clutter.
 *
 * All `onChange` handlers fire optimistically: the parent merges the
 * value into the local snapshot via `applyEvent` before the server
 * round-trip resolves, so the dropdown reflects the new choice
 * immediately. A `502` from the agent surfaces as a thrown error the
 * parent can choose to revert on.
 */

import { useMemo } from 'react';

import { Select, type SelectOption } from '../../Common/Select';

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
      { value: 'true', label: 'On' },
      { value: 'false', label: 'Off' },
    ];
    return (
      <Select<'true' | 'false'>
        options={options}
        value={current ? 'true' : 'false'}
        onChange={(next) => void onSelect(next === 'true')}
        disabled={disabled}
        title={label}
        variant="ghost"
        shape="pill"
        tone="neutral"
        size="sm"
        align="top-left"
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
    <Select<string>
      options={flat}
      value={value}
      onChange={(next) => void onSelect(next)}
      disabled={disabled}
      title={label}
      variant="ghost"
      shape="pill"
      tone="neutral"
      size="sm"
      align="top-left"
    />
  );
}

export const AcpSessionSelectors = ({
  meta,
  disabled = false,
  onSelectMode,
  onSelectModel,
  onSelectConfigOption,
}: AcpSessionSelectorsProps) => {
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

  // Copilot CLI (and likely other agents) publish `mode` and `model`
  // through BOTH `modes`/`models` AND `configOptions`. When the
  // dedicated selector is visible, drop the config-option twin so the
  // toolbar doesn't show two identical pills. We only suppress on
  // exact id collision with the dedicated channel — agents that ship
  // the value only via `configOptions` still get a pill.
  const visibleConfigOptions = useMemo(
    () =>
      meta.configOptions.filter((opt) => {
        const id = String((opt as { id?: unknown }).id ?? '')
          .trim()
          .toLowerCase();
        if (hasMode && id === 'mode') return false;
        if (hasModel && id === 'model') return false;
        return true;
      }),
    [meta.configOptions, hasMode, hasModel],
  );
  const hasConfig = visibleConfigOptions.length > 0;
  if (!hasMode && !hasModel && !hasConfig) return null;

  return (
    <>
      {hasMode && (
        <Select<string>
          options={modeOptions}
          value={meta.currentModeId ?? modeOptions[0].value}
          onChange={(next) => void onSelectMode(next)}
          disabled={disabled}
          title="Agent Mode"
          variant="ghost"
          shape="pill"
          tone="neutral"
          size="sm"
          align="top-left"
        />
      )}
      {hasModel && (
        <Select<string>
          options={modelOptions}
          value={meta.currentModelId ?? modelOptions[0].value}
          onChange={(next) => void onSelectModel(next)}
          disabled={disabled}
          title="Model"
          variant="ghost"
          shape="pill"
          tone="neutral"
          size="sm"
          align="top-left"
        />
      )}
      {meta.configOptions.length > 0 &&
        visibleConfigOptions.map((opt) => {
          const id = String((opt as { id?: unknown }).id ?? '');
          if (!id) return null;
          return (
            <ConfigOptionSelect
              key={id}
              option={opt}
              disabled={disabled}
              onSelect={(value) => onSelectConfigOption(id, value)}
            />
          );
        })}
    </>
  );
};
