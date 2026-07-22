/**
 * Pure helpers for reasoning about ACP session `configOptions`, split out
 * from the React `AcpSessionSelectors` component so they can be unit-tested
 * without importing the component's UI dependency graph.
 *
 * The modern `configOptions` channel is the source of truth for the model
 * and mode pickers: when an agent publishes a `category: 'model'` / `'mode'`
 * option, its clean picker replaces the legacy `availableModels` /
 * `availableModes` list (which some agents, e.g. codex-acp, flatten into
 * base × reasoning-effort combinations — microsoft/Huabu#31). Detection is
 * by the SDK's semantic `category` with an id fallback, so it holds
 * regardless of the agent's option-id naming.
 */

import type { AcpSessionConfigOption } from '@sediment/shared';

/** Lowercased, trimmed `id` of an ACP config option. */
export const configOptionId = (opt: AcpSessionConfigOption): string =>
  String((opt as { id?: unknown }).id ?? '')
    .trim()
    .toLowerCase();

/**
 * Lowercased, trimmed `category` of an ACP config option. The SDK's
 * `SessionConfigOptionCategory` reserves `'mode'` / `'model'` /
 * `'thought_level'` and allows custom strings, so this is the semantic
 * signal for what a knob controls, independent of its id naming.
 */
export const configOptionCategory = (opt: AcpSessionConfigOption): string =>
  String((opt as { category?: unknown }).category ?? '')
    .trim()
    .toLowerCase();

/** Whether a config option is the modern base-model picker. */
export const isModelConfigOption = (opt: AcpSessionConfigOption): boolean =>
  configOptionCategory(opt) === 'model' || configOptionId(opt) === 'model';

/** Whether a config option is the modern mode picker. */
export const isModeConfigOption = (opt: AcpSessionConfigOption): boolean =>
  configOptionCategory(opt) === 'mode' || configOptionId(opt) === 'mode';
