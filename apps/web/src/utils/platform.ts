// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Whether the current browser is running on macOS / iOS. Cached at module
 * load — the platform does not change at runtime, so there's no benefit to
 * recomputing this on every render or wrapping it in a hook.
 */
export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  'Ctrl/Cmd': '⌘',
  Cmd: '⌘',
  Meta: '⌘',
  Ctrl: '⌃',
  Shift: '⇧',
  Alt: '⌥',
  Option: '⌥',
};

const KEY_GLYPHS: Record<string, string> = {
  Plus: '+',
  Minus: '−', // U+2212 minus sign — visually distinct from the `+` separator
  Equal: '=',
};

/**
 * Split a shortcut template like `Ctrl/Cmd+Shift+Plus` into per-key display
 * tokens, applying OS-appropriate modifier symbols and friendly key glyphs.
 *
 * `Plus` / `Minus` / `Equal` placeholders collapse to `+` / `−` / `=` so
 * shortcut configs can express those keys without colliding with the `+`
 * separator (avoiding the ambiguous `Ctrl/Cmd++`). Unknown tokens pass
 * through unchanged, which keeps descriptive labels like `Space (hold)` or
 * `Delete / Backspace` intact.
 */
export function shortcutTokens(template: string): string[] {
  return template.split('+').map((raw) => {
    const tok = raw.trim();
    if (isMac && MAC_MODIFIER_SYMBOLS[tok]) return MAC_MODIFIER_SYMBOLS[tok];
    if (!isMac && tok === 'Ctrl/Cmd') return 'Ctrl';
    return KEY_GLYPHS[tok] ?? tok;
  });
}

/**
 * Render a cross-platform shortcut template using OS-appropriate notation.
 *
 * Templates use the `Ctrl/Cmd` placeholder convention established by
 * `config/shortcuts.ts`. On macOS / iOS the tokens are concatenated with
 * Apple-native symbols (e.g. `Ctrl/Cmd+Shift+Z` → `⌘⇧Z`); on other
 * platforms tokens are joined with `+` (e.g. `Ctrl+Shift+Z`).
 *
 * Returns a compact textual form suitable for menu hints. For richer UI
 * (e.g. the keyboard shortcuts modal) consume `shortcutTokens` directly so
 * each token can be rendered as its own chip.
 */
export function formatShortcut(template: string): string {
  const tokens = shortcutTokens(template);
  return isMac ? tokens.join('') : tokens.join('+');
}
