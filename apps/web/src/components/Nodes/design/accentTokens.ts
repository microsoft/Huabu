// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isAccentToken } from '@huabu/shared';

import { resolveAccentCss } from '@/utils/accentColor';

/** % of accent mixed into the default foreground for text/icon color. */
const ACCENT_FG_MIX = 60;
/** % of accent mixed over the surface for tinted backgrounds. */
const ACCENT_BG_MIX = 15;
/** % of custom accent over the page background for section dividers. */
const ACCENT_DIVIDER_MIX = 30;
/** % of custom accent over the surface for inline text highlights. */
const ACCENT_HIGHLIGHT_BG_MIX = 25;

/**
 * Matches "white-ish" accent strings (CSS keyword `white`, `#fff`, `#ffffff`).
 * White is an achromatic accent: mixing it into the default dark foreground
 * just lightens it into a mid-gray that reads as a washed-out, "wrong"
 * color — especially in `SemanticPlaceholder` where the whole card is a
 * single tinted label. For these inputs we skip the `fg` mix and fall back
 * to the regular foreground color, which reads correctly in both themes.
 */
const WHITE_ACCENT_RE = /^\s*(white|#fff|#ffffff)\s*$/i;

export function isWhiteAccent(accent: string): boolean {
  return WHITE_ACCENT_RE.test(accent);
}

export interface AccentTokens {
  /** Foreground color for text and icons on accent-tinted surfaces. */
  fg: string;
  /** Text-node foreground, calibrated against softBg rather than highlightBg. */
  textFg: string;
  /** Background color for an accent-tinted surface. */
  bg: string;
  /** Solid accent border (e.g. card outline). */
  border: string;
  /** Thin accent divider (e.g. section separator). */
  divider: string;
  /** Very subtle accent tint for static section backgrounds. */
  softBg: string;
  /** Inline text highlight background. */
  highlightBg: string;
}

/** Preserve preset identity; only legacy/custom colors use runtime mixing. */
export function getAccentTokens(accent: string): AccentTokens {
  if (isAccentToken(accent)) {
    return {
      fg: `var(--accent-${accent}-fg)`,
      textFg: `var(--accent-${accent}-text-fg)`,
      bg: `var(--accent-${accent}-bg)`,
      border: resolveAccentCss(accent),
      divider: `var(--accent-${accent}-divider)`,
      softBg: `var(--accent-${accent}-soft-bg)`,
      highlightBg: `var(--accent-${accent}-highlight-bg)`,
    };
  }
  // White accent: keep text at the regular foreground color so it reads as
  // black (light theme) / white (dark theme) instead of mid-gray.
  const fg = isWhiteAccent(accent)
    ? 'var(--fg-default)'
    : `color-mix(in srgb, ${accent} ${ACCENT_FG_MIX}%, var(--fg-default))`;

  return {
    fg,
    textFg: fg,
    bg: `color-mix(in srgb, ${accent} ${ACCENT_BG_MIX}%, var(--bg-surface))`,
    border: accent,
    divider: `color-mix(in srgb, ${accent} ${ACCENT_DIVIDER_MIX}%, var(--bg-default))`,
    softBg: `color-mix(in srgb, color-mix(in srgb, ${accent} ${ACCENT_BG_MIX}%, var(--bg-surface)) 50%, var(--bg-note-surface))`,
    highlightBg: `color-mix(in srgb, ${accent} ${ACCENT_HIGHLIGHT_BG_MIX}%, var(--bg-surface))`,
  };
}
