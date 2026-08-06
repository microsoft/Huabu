/**
 * Normalisation of an ACP session-meta snapshot into a single, flat list
 * of renderable selector descriptors.
 *
 * An agent can advertise the *same* knob through two unrelated channels:
 *
 *   • the legacy per-session lists — `availableModes` + `currentModeId`,
 *     `availableModels` + `currentModelId`, driven by `session/setSessionMode`
 *     and `session/setSessionModel`;
 *   • the modern `configOptions` array, driven by
 *     `session/setSessionConfigOption`.
 *
 * Agents disagree about which to use: some publish only the legacy lists,
 * some only config options, and some (codex-acp) publish both — with a
 * legacy model list that flattens every base model × reasoning effort while
 * the config-option twin exposes a clean base-model picker plus a separate
 * reasoning control (microsoft/Huabu#31). Every consumer that had to pick a
 * channel grew its own `showLegacyModel` heuristic, and those heuristics
 * drifted. This module owns the choice exactly once.
 *
 * It also resolves *which value is current*, which is a second thing agents
 * disagree about. `configOptions[].currentValue` and `currentModeId` /
 * `currentModelId` carry the AGENT's view, and for agents whose settings are
 * process-global (Copilot CLI) that is the value last picked in *any*
 * session, not in this one. So an explicit per-thread selection recorded in
 * `selections` always wins — see `AcpSessionMetaSnapshot.selections`.
 *
 * Pure, dependency-free and browser-safe: the server uses it to reason about
 * a cached snapshot, the web bundle uses it as the only read path backing the
 * toolbar pills.
 */

/** Which set-RPC a change to a selector must be routed through. */
export type AcpSessionSelectorChannel = 'mode' | 'model' | 'config-option';

/** One choice in a `kind: 'select'` selector, already flattened. */
export interface AcpSessionSelectorOption {
  /** Value handed back to the set-RPC. */
  value: string;
  /** Display label. */
  label: string;
  /** Optional secondary line. */
  description?: string;
  /**
   * Group heading. Set only on the FIRST entry of a group so a renderer can
   * emit a section divider without re-deriving group boundaries.
   */
  sectionLabel?: string;
}

/** A single renderable knob, channel-agnostic. */
export interface AcpSessionSelector {
  /**
   * Config-option id, or the reserved `'mode'` / `'model'` key when this
   * selector was synthesised from the legacy lists. Doubles as the key into
   * `AcpSessionMetaSnapshot.selections`.
   */
  id: string;
  /**
   * Lowercased semantic `category` — `'mode'` / `'model'` / `'thought_level'`
   * or an agent-defined string. Empty when the agent published none.
   */
  category: string;
  /**
   * Agent-published display name. Empty for synthesised legacy selectors,
   * which have no name of their own; renderers substitute a localised
   * fallback keyed off {@link category}.
   */
  label: string;
  kind: 'select' | 'boolean';
  /** Flattened choices. Always empty for `kind: 'boolean'`. */
  options: AcpSessionSelectorOption[];
  currentValue: string | boolean;
  channel: AcpSessionSelectorChannel;
  /**
   * `'user'` when {@link currentValue} came from an explicit per-thread
   * selection, `'agent'` when it is whatever the agent last reported.
   */
  source: 'user' | 'agent';
}

/**
 * Structural subset of `AcpSessionMetaSnapshot` this module reads. Kept
 * loose (`unknown[]`) because the entries are re-exported ACP SDK unions
 * whose shape varies between agents and SDK versions; every field access
 * below is defensive.
 */
export interface AcpSessionSelectorSource {
  availableModes: readonly unknown[];
  currentModeId: string | null;
  availableModels: readonly unknown[];
  currentModelId: string | null;
  configOptions: readonly unknown[];
  selections: Readonly<Record<string, string | boolean>>;
}

/** Reserved `selections` key for the legacy mode channel. */
export const MODE_SELECTION_ID = 'mode';
/** Reserved `selections` key for the legacy model channel. */
export const MODEL_SELECTION_ID = 'model';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const normalizeKey = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * Flatten the many shapes an agent may use for a select option list:
 * bare strings, `{ name, value }` / `{ label, id }` records, and group
 * records (`{ name, options: [...] }`) which are inlined with a
 * `sectionLabel` on their first child.
 */
function flattenOptions(raw: unknown): AcpSessionSelectorOption[] {
  if (!Array.isArray(raw)) return [];
  const flat: AcpSessionSelectorOption[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      flat.push({ value: entry, label: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    if (Array.isArray(e.options) && typeof e.name === 'string') {
      const groupLabel = e.name;
      let isFirst = true;
      for (const sub of e.options) {
        const s = asRecord(sub);
        const value = String(s.value ?? s.id ?? '');
        if (!value) continue;
        flat.push({
          value,
          label: String(s.name ?? s.label ?? value),
          ...(isFirst ? { sectionLabel: groupLabel } : {}),
          ...(typeof s.description === 'string'
            ? { description: s.description }
            : {}),
        });
        isFirst = false;
      }
      continue;
    }

    const value = String(e.value ?? e.id ?? '');
    if (!value) continue;
    flat.push({
      value,
      label: String(e.name ?? e.label ?? value),
      ...(typeof e.description === 'string'
        ? { description: e.description }
        : {}),
    });
  }
  return flat;
}

/**
 * Resolve the value to render, preferring the explicit per-thread selection
 * over the agent-reported one.
 *
 * A recorded selection is ignored when it cannot apply to the knob as it
 * exists right now — wrong primitive type, or a select value the agent no
 * longer offers. That happens after an agent upgrade retires a model id, and
 * honouring it would render an empty pill that the user cannot correct.
 */
function resolveValue(
  selection: string | boolean | undefined,
  agentValue: string | boolean,
  kind: 'select' | 'boolean',
  options: AcpSessionSelectorOption[],
): { currentValue: string | boolean; source: 'user' | 'agent' } {
  if (selection === undefined)
    return { currentValue: agentValue, source: 'agent' };
  if (kind === 'boolean') {
    return typeof selection === 'boolean'
      ? { currentValue: selection, source: 'user' }
      : { currentValue: agentValue, source: 'agent' };
  }
  if (typeof selection !== 'string') {
    return { currentValue: agentValue, source: 'agent' };
  }
  return options.some((o) => o.value === selection)
    ? { currentValue: selection, source: 'user' }
    : { currentValue: agentValue, source: 'agent' };
}

/**
 * The spellings a fork that serialises booleans as strings uses for off.
 * Anything else keeps the truthiness of the raw string, so an unlisted
 * on-word such as `'enabled'` still reads as on.
 */
const BOOLEAN_OFF_STRINGS: ReadonlySet<string> = new Set([
  '',
  'false',
  '0',
  'off',
  'no',
]);

/** Build the selector descriptor for one `configOptions` entry. */
function selectorFromConfigOption(
  raw: unknown,
  selections: Readonly<Record<string, string | boolean>>,
): AcpSessionSelector | null {
  const opt = asRecord(raw);
  const id = String(opt.id ?? '').trim();
  if (!id) return null;

  const category = normalizeKey(opt.category);
  const label = String(opt.name ?? opt.label ?? id);
  // Some forks emit `kind` where the SDK emits `type`.
  const declaredType = normalizeKey(opt.type ?? opt.kind);
  const selection = selections[id];

  if (declaredType === 'boolean') {
    // Plain truthiness would report the string `'false'` as on.
    const rawValue = opt.currentValue;
    const agentValue =
      typeof rawValue === 'string'
        ? !BOOLEAN_OFF_STRINGS.has(rawValue.trim().toLowerCase())
        : Boolean(rawValue);
    const { currentValue, source } = resolveValue(
      selection,
      agentValue,
      'boolean',
      [],
    );
    return {
      id,
      category,
      label,
      kind: 'boolean',
      options: [],
      currentValue,
      channel: 'config-option',
      source,
    };
  }

  // Accept the SDK's `options` as well as the `values` some forks emit.
  const options = flattenOptions(opt.options ?? opt.values);
  // Unknown type with nothing to pick from: drop it rather than render a
  // pill the user cannot operate.
  if (options.length === 0) return null;

  // The agent can publish an option before it reports a value; fall back to
  // the first choice so the trigger shows something meaningful.
  const agentValue = String(opt.currentValue ?? '') || options[0].value;
  const { currentValue, source } = resolveValue(
    selection,
    agentValue,
    'select',
    options,
  );
  return {
    id,
    category,
    label,
    kind: 'select',
    options,
    currentValue,
    channel: 'config-option',
    source,
  };
}

/**
 * Project a session-meta snapshot into the flat selector list to render, in
 * toolbar order: the synthesised legacy mode / model pills first (when the
 * agent publishes no config-option twin for them), then every config option
 * in publish order.
 *
 * Returns an empty array when the agent advertises nothing selectable — the
 * caller renders no toolbar rather than empty pills.
 */
export function buildAcpSessionSelectors(
  meta: AcpSessionSelectorSource,
): AcpSessionSelector[] {
  const configSelectors: AcpSessionSelector[] = [];
  let hasModeConfigOption = false;
  let hasModelConfigOption = false;

  for (const raw of meta.configOptions) {
    const selector = selectorFromConfigOption(raw, meta.selections);
    if (!selector) continue;
    const key = selector.category || normalizeKey(selector.id);
    if (key === 'mode') hasModeConfigOption = true;
    if (key === 'model') hasModelConfigOption = true;
    configSelectors.push(selector);
  }

  const legacy: AcpSessionSelector[] = [];

  if (!hasModeConfigOption) {
    const options = flattenOptions(meta.availableModes);
    if (options.length > 0) {
      const agentValue = meta.currentModeId ?? options[0].value;
      const { currentValue, source } = resolveValue(
        meta.selections[MODE_SELECTION_ID],
        agentValue,
        'select',
        options,
      );
      legacy.push({
        id: MODE_SELECTION_ID,
        category: 'mode',
        label: '',
        kind: 'select',
        options,
        currentValue,
        channel: 'mode',
        source,
      });
    }
  }

  if (!hasModelConfigOption) {
    // `AcpModelInfo` keys its id as `modelId`; normalise to `id` so the
    // shared flattener applies.
    const options = flattenOptions(
      meta.availableModels.map((m) => {
        const model = asRecord(m);
        return { ...model, id: model.modelId ?? model.id };
      }),
    );
    if (options.length > 0) {
      const agentValue = meta.currentModelId ?? options[0].value;
      const { currentValue, source } = resolveValue(
        meta.selections[MODEL_SELECTION_ID],
        agentValue,
        'select',
        options,
      );
      legacy.push({
        id: MODEL_SELECTION_ID,
        category: 'model',
        label: '',
        kind: 'select',
        options,
        currentValue,
        channel: 'model',
        source,
      });
    }
  }

  return [...legacy, ...configSelectors];
}
