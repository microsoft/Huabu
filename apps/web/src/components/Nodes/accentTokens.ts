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
/** % of accent over transparent for hover backgrounds. */
const ACCENT_HOVER_MIX = 8;
/** % of accent over transparent for very subtle section tints. */
const ACCENT_SOFT_MIX = 4;
/** % of accent over transparent for a solid accent border. */
const ACCENT_BORDER_MIX = 50;
/** % of accent over transparent for a thin accent divider. */
const ACCENT_DIVIDER_MIX = 25;

export interface AccentTokens {
  /** Foreground color for text and icons on accent-tinted surfaces. */
  fg: string;
  /** Background color for an accent-tinted surface. */
  bg: string;
  /** Solid accent border (e.g. card outline). */
  border: string;
  /** Thin accent divider (e.g. section separator). */
  divider: string;
  /** Hover background tint over a neutral surface. */
  hoverBg: string;
  /** Very subtle accent tint for static section backgrounds. */
  softBg: string;
  /** Strong accent color for drop shadows (frame node uses 100% accent). */
  shadow: string;
}

export function getAccentTokens(accent: string): AccentTokens {
  return {
    fg: `color-mix(in srgb, ${accent} ${ACCENT_FG_MIX}%, var(--fg-default))`,
    bg: `color-mix(in srgb, ${accent} ${ACCENT_BG_MIX}%, var(--bg-surface))`,
    // Use color-mix for alpha so any valid CSS color works (hex, keywords
    // like `white`, `var(...)`, etc.). The previous hex-suffix approach
    // produced invalid strings like `white80` for non-hex inputs, which the
    // browser silently rejects -> the previous border color stayed in the
    // inline style and the swatch appeared to "stick".
    border: `color-mix(in srgb, ${accent} ${ACCENT_BORDER_MIX}%, transparent)`,
    divider: `color-mix(in srgb, ${accent} ${ACCENT_DIVIDER_MIX}%, transparent)`,
    hoverBg: `color-mix(in srgb, ${accent} ${ACCENT_HOVER_MIX}%, transparent)`,
    softBg: `color-mix(in srgb, ${accent} ${ACCENT_SOFT_MIX}%, transparent)`,
    shadow: accent,
  };
}
