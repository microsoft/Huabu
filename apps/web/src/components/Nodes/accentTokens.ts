// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared accent-color derivation for canvas nodes.
 *
 * Both `SemanticPlaceholder` (minimal LOD) and `PreviewCard` (full LOD) render
 * the same node at different zoom levels. To avoid a visible color "jump" when
 * the LOD changes, both must derive their tinted tokens from the same formulas.
 * This module is the single source of truth for those formulas.
 */

/** % of accent mixed into the default foreground for text/icon color. */
const ACCENT_FG_MIX = 60;
/** % of accent mixed over the surface for tinted backgrounds. */
const ACCENT_BG_MIX = 10;
/** % of accent over transparent for very subtle section tints. */
const ACCENT_SOFT_MIX = 4;
/**
 * % of accent over transparent for a solid node border.
 *
 * Edges use the raw accent at 100%. Node borders are thicker and cover a much
 * larger perimeter, so keeping them slightly quieter preserves hierarchy while
 * 75% remains close enough for a node and its same-accent edge to read as one
 * visual family.
 */
const ACCENT_BORDER_MIX = 75;
/** % of accent over transparent for a thin accent divider. */
const ACCENT_DIVIDER_MIX = 25;
/** % of accent over transparent for inline text highlights. */
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

export interface AccentTokens {
  /** Foreground color for text and icons on accent-tinted surfaces. */
  fg: string;
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

export function getAccentTokens(accent: string): AccentTokens {
  // White accent: keep text at the regular foreground color so it reads as
  // black (light theme) / white (dark theme) instead of mid-gray.
  const fg = WHITE_ACCENT_RE.test(accent)
    ? 'var(--fg-default)'
    : `color-mix(in srgb, ${accent} ${ACCENT_FG_MIX}%, var(--fg-default))`;

  return {
    fg,
    bg: `color-mix(in srgb, ${accent} ${ACCENT_BG_MIX}%, var(--bg-surface))`,
    // Use color-mix for alpha so any valid CSS color works (hex, keywords
    // like `white`, `var(...)`, etc.). The previous hex-suffix approach
    // produced invalid strings like `white80` for non-hex inputs, which the
    // browser silently rejects -> the previous border color stayed in the
    // inline style and the swatch appeared to "stick".
    border: `color-mix(in srgb, ${accent} ${ACCENT_BORDER_MIX}%, transparent)`,
    divider: `color-mix(in srgb, ${accent} ${ACCENT_DIVIDER_MIX}%, transparent)`,
    softBg: `color-mix(in srgb, ${accent} ${ACCENT_SOFT_MIX}%, transparent)`,
    highlightBg: `color-mix(in srgb, ${accent} ${ACCENT_HIGHLIGHT_BG_MIX}%, transparent)`,
  };
}
