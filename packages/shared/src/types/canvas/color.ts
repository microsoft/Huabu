/**
 * Canvas Color Types
 * Shared color palettes for canvas styling.
 *
 * Two palettes, two purposes
 * --------------------------
 * The app maintains two **independent** palettes that are NOT interchangeable.
 * Their hex families are deliberately tuned for different visual roles and
 * neither is a valid substitute for the other.
 *
 *   ACCENT_PALETTE  — saturated colors, used for emphasis:
 *                     `style.accent`, `style.textColor`, edge `stroke`.
 *                     "No accent" is encoded as `null` (field absent), not as
 *                     a transparent color — the renderer skips the layer.
 *
 *   SURFACE_PALETTE — very light tinted fills, used for node backgrounds
 *                     (`style.backgroundColor`). The first entry is
 *                     `transparent`, which is the conceptual default: the
 *                     node lets the canvas show through.
 *
 * Storage model
 * -------------
 * All four color-style fields are stored as **palette tokens** (e.g. `'purple'`,
 * `'transparent'`).  Tokens are stable identifiers that map to a current hex
 * via the palettes below — re-skinning the app means changing those `value`s
 * once and every existing canvas follows automatically.
 *
 * Two kinds of string may legitimately appear in stored data:
 *   1. A known token  → resolved through the palette (theme-aware)
 *   2. A literal hex  → treated as a user-fixed custom color (theme-frozen)
 *
 * Read boundaries (renderer) are tolerant: unknown values pass through
 * unchanged so unusual one-off CSS strings — e.g. `var(--question-bg)` on
 * the Question node — keep working. Write boundaries (tool schemas, REST
 * endpoints, importers) are responsible for their own validation.
 *
 * Naming convention
 * -----------------
 * Helpers come in symmetric `accent*` / `surface*` pairs:
 *   - `resolveAccent`  / `resolveSurface`  (read boundary)
 *   - `isAccentToken`  / `isSurfaceToken`  (type guards)
 *   - `accentName`     / `surfaceName`     (display labels)
 */

/**
 * Accent palette — saturated colors for emphasis layers.
 * Used by `style.accent`, `style.textColor`, and edge `stroke`.
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
 * One swatch entry as consumed by the accent / surface color pickers.
 * Mirrors the structural shape of `ACCENT_PALETTE` / `SURFACE_PALETTE`
 * entries and the web app's `ColorPreset` interface.
 */
export interface ColorPickerOption {
  token: string;
  name: string;
  value: string;
}

/**
 * Default accent picker swatches. Starts with neutral Black + White swatches
 * followed by the saturated palette. **Does not** include a "Transparent"
 * option — used by every node type whose visual identity depends on a solid
 * background (frame, note, image, pdf, video, web, sketch), since a
 * transparent fill would make those nodes effectively invisible.
 *
 * Black and White are picker-only entries (not part of `ACCENT_PALETTE`):
 * neither token resolves through `ACCENT_BY_TOKEN`, so they fall through
 * `resolveAccent`'s passthrough branch and render as the literal CSS color
 * keyword. That's intentional — they're fixed neutrals that should not
 * shift with theme re-skins of the saturated palette.
 */
export const ACCENT_PICKER_OPTIONS: readonly ColorPickerOption[] = [
  { token: 'black', name: 'Black', value: '#000000' },
  { token: 'white', name: 'White', value: '#ffffff' },
  ...ACCENT_PALETTE,
];

/**
 * Accent picker swatches **with** a leading "Transparent" sentinel.
 * Used only by node types that render as plain floating content on the
 * canvas (currently `text`), where "no background fill" is a meaningful and
 * common selection.
 */
export const ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT: readonly ColorPickerOption[] =
  [
    { token: ACCENT_NONE_TOKEN, name: 'Transparent', value: 'transparent' },
    ...ACCENT_PICKER_OPTIONS,
  ];

/**
 * Surface palette — very light tinted fills for node backgrounds.
 * Used by `style.backgroundColor`.
 *
 * The first entry (`transparent`) is the visual default: the node simply
 * lets the canvas background show through.
 */
export const SURFACE_PALETTE = [
  { token: 'transparent', name: 'Default', value: 'transparent' },
  { token: 'white', name: 'White', value: '#ffffff' },
  { token: 'red', name: 'Red', value: '#fef2f2' },
  { token: 'orange', name: 'Orange', value: '#fff7ed' },
  { token: 'yellow', name: 'Yellow', value: '#fefce8' },
  { token: 'green', name: 'Green', value: '#f0fdf4' },
  { token: 'blue', name: 'Blue', value: '#eff6ff' },
  { token: 'purple', name: 'Purple', value: '#faf5ff' },
] as const;

export type SurfaceEntry = (typeof SURFACE_PALETTE)[number];
export type SurfaceToken = SurfaceEntry['token'];
export type SurfaceValue = SurfaceEntry['value'];

// ---- Lookups (built once at module load) ----

const ACCENT_BY_TOKEN: Readonly<Record<string, AccentEntry>> = Object.freeze(
  Object.fromEntries(ACCENT_PALETTE.map((c) => [c.token, c])),
);

const SURFACE_BY_TOKEN: Readonly<Record<string, SurfaceEntry>> = Object.freeze(
  Object.fromEntries(SURFACE_PALETTE.map((c) => [c.token, c])),
);

/** Matches `#RGB`, `#RRGGBB`, `#RRGGBBAA`. */
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// ---- Type guards ----

export function isAccentToken(x: unknown): x is AccentToken {
  return typeof x === 'string' && x in ACCENT_BY_TOKEN;
}

export function isSurfaceToken(x: unknown): x is SurfaceToken {
  return typeof x === 'string' && x in SURFACE_BY_TOKEN;
}

export function isHexColor(x: unknown): x is string {
  return typeof x === 'string' && HEX_RE.test(x);
}

// ---- Read-side resolvers (token | legacy hex → renderable CSS color) ----

/**
 * Resolve a stored accent value to a CSS color string.
 * - Known token → current hex from `ACCENT_PALETTE` (theme-aware).
 * - Anything else (hex, CSS keyword, `var(...)`, etc.) → returned as-is so
 *   the renderer can still display it. Unknown values are NOT rejected here
 *   because read-side must be tolerant of legacy data and one-off CSS values
 *   used by special node types (e.g. QuestionNode's `var(--question-bg)`).
 * - `null` / `undefined` / empty → `null`.
 */
export function resolveAccent(input: string | null | undefined): string | null {
  if (!input) return null;
  if (isAccentToken(input)) return ACCENT_BY_TOKEN[input].value;
  return input;
}

/**
 * Resolve a stored surface (node background) value to a CSS color string.
 * Same passthrough behaviour as `resolveAccent`, but uses `SURFACE_PALETTE`
 * (which includes `'transparent'` as a token).
 */
export function resolveSurface(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  if (isSurfaceToken(input)) return SURFACE_BY_TOKEN[input].value;
  return input;
}

// ---- Display helpers (English fallback; swap for t() once i18n lands) ----

export function accentName(token: AccentToken): string {
  return ACCENT_BY_TOKEN[token].name;
}

export function surfaceName(token: SurfaceToken): string {
  return SURFACE_BY_TOKEN[token].name;
}
