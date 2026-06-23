/**
 * Canvas Color Types
 *
 * Single source of truth for canvas color styling: `ACCENT_PALETTE`.
 *
 * One token, three visuals
 * ------------------------
 * A single `style.accent` token drives a node's **border**, **fill tint**,
 * and **text tint** via `accentTokens` (web side). The previous parallel
 * `style.backgroundColor` (SURFACE_PALETTE) and `style.textColor` fields
 * were removed in 2026-06-17 so the AI and the UI cannot desynchronise the
 * three layers. "No accent" is encoded as `null` (field absent); the
 * renderer falls back to a neutral surface.
 *
 * Storage model
 * -------------
 * `style.accent` is stored as a **palette token** (e.g. `'purple'`).
 * Tokens are stable identifiers that map to a current hex via
 * `ACCENT_PALETTE` — re-skinning the app means changing those `value`s
 * once and every existing canvas follows automatically.
 *
 * Two kinds of string may legitimately appear in stored data:
 *   1. A known token  → resolved through the palette (theme-aware)
 *   2. A literal hex / CSS keyword → treated as a user-fixed custom
 *      color (theme-frozen). Tolerated by `resolveAccent` for legacy
 *      data; write boundaries (agent schema, UI pickers) restrict input
 *      to palette tokens.
 */

/**
 * Accent palette — saturated colors for emphasis layers.
 * Used by `style.accent`, edge `stroke`, and (passthrough-only) sketch
 * `strokeColor`.
 *
 * Entry shape:
 * - `token`: stable code/data identifier — NEVER change once shipped.
 * - `name`:  default English display label (also used as i18n fallback key).
 * - `value`: current hex; safe to swap when re-skinning.
 *
 * The first entry is treated as the visually-neutral default in the toolbar,
 * but "no accent" itself is `null`, not a palette entry.
 */
export const ACCENT_PALETTE = [
  { token: 'grey', name: 'Grey', value: '#A8A29E' },
  { token: 'red', name: 'Red', value: '#D07C74' },
  { token: 'orange', name: 'Orange', value: '#D89A5B' },
  { token: 'amber', name: 'Amber', value: '#F2D479' },
  { token: 'green', name: 'Green', value: '#7FB38A' },
  { token: 'blue', name: 'Blue', value: '#5F8F9B' },
  { token: 'purple', name: 'Purple', value: '#A08FC0' },
] as const;

export type AccentEntry = (typeof ACCENT_PALETTE)[number];
export type AccentToken = AccentEntry['token'];
export type AccentValue = AccentEntry['value'];

/**
 * Sentinel token used by accent pickers to represent "no accent" in their
 * selected-value field. Canvas data still encodes "no accent" as
 * `style.accent: null`; the toolbar maps `null ↔ ACCENT_NONE_TOKEN` at the
 * UI boundary so the picker's selected value can stay a plain string.
 */
export const ACCENT_NONE_TOKEN = 'none' as const;

/**
 * One swatch entry as consumed by the accent color picker.
 * Mirrors the structural shape of `ACCENT_PALETTE` entries and the web
 * app's `ColorPreset` interface.
 */
export interface ColorPickerOption {
  token: string;
  name: string;
  value: string;
}

/**
 * Accent picker swatches **with** a leading "Transparent" sentinel.
 * Every node renders with a null accent by default (a neutral surface or
 * fully transparent shell), so the picker always needs a swatch that can
 * represent that "no accent" state — otherwise selecting a colour would
 * be a one-way trip with no path back to the default. The legacy palette
 * without a transparent entry remains exported as `ACCENT_PALETTE` for
 * non-picker call sites (edge stroke, sketch stroke colour, etc.).
 */
export const ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT: readonly ColorPickerOption[] =
  [
    { token: ACCENT_NONE_TOKEN, name: 'Transparent', value: 'transparent' },
    ...ACCENT_PALETTE,
  ];

// ---- Lookups (built once at module load) ----

const ACCENT_BY_TOKEN: Readonly<Record<string, AccentEntry>> = Object.freeze(
  Object.fromEntries(ACCENT_PALETTE.map((c) => [c.token, c])),
);

/** Matches `#RGB`, `#RRGGBB`, `#RRGGBBAA`. */
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// ---- Type guards ----

export function isAccentToken(x: unknown): x is AccentToken {
  return typeof x === 'string' && x in ACCENT_BY_TOKEN;
}

export function isHexColor(x: unknown): x is string {
  return typeof x === 'string' && HEX_RE.test(x);
}

// ---- Read-side resolvers (token | legacy hex → renderable CSS color) ----

/**
 * Resolve a stored accent value to a CSS color string.
 * - Known token → current hex from `ACCENT_PALETTE` (theme-aware).
 * - Anything else (hex, CSS keyword, `var(...)`, etc.) → returned as-is so
 *   the renderer can still display legacy data and one-off CSS values
 *   (e.g. sketch `strokeColor: 'black'`, QuestionNode's sticky fill).
 * - `null` / `undefined` / empty → `null`.
 */
export function resolveAccent(input: string | null | undefined): string | null {
  if (!input) return null;
  if (isAccentToken(input)) return ACCENT_BY_TOKEN[input].value;
  return input;
}

// ---- Display helpers (English fallback; swap for t() once i18n lands) ----

export function accentName(token: AccentToken): string {
  return ACCENT_BY_TOKEN[token].name;
}
