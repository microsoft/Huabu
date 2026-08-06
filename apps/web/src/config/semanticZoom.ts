// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Semantic Zoom configuration.
 *
 * Controls when heavy node types switch from full rendering to a
 * lightweight placeholder based on their screen-space size.
 *
 * Design principle: at a given viewport zoom, a node's placeholder font
 * expresses HIERARCHY (node size), never content length. Same-size nodes
 * always render the same font size, so the zoomed-out canvas keeps a stable
 * typographic rhythm instead of a 42px label next to an 11px one. Titles
 * that don't fit wrap (never mid-word) and then ellipsize; they never keep
 * shrinking to fit. Because the tier font is a canvas size, the label simply
 * scales down with the node as you zoom out — a smaller node always shows
 * smaller text, with no separate icon/glyph floor.
 *
 * The reduced render is a single step:
 *   full   → original component
 *   minimal→ tier-sized label (+ wrap/clamp) — see MINIMAL_TYPOGRAPHY_SCALE
 *
 * To add a tier, edit MINIMAL_TYPOGRAPHY_SCALE / the config below — both are
 * pure data so tuning never touches render logic.
 */

/** LOD levels — extensible. */
export type ZoomLOD = 'full' | 'minimal';

/**
 * What to render for a given node.
 * 'full' = original component, 'minimal' = tier-sized label placeholder.
 */
export type LODRenderMode = 'full' | 'minimal';

export interface SemanticZoomConfig {
  /** Screen-space width thresholds in pixels (descending order) */
  screenThresholds: Partial<Record<Exclude<ZoomLOD, 'full'>, number>>;
  /** Hysteresis buffer in pixels to prevent rapid full↔minimal toggling */
  hysteresis: number;
  /**
   * Per-node-type render mode at each opt-in LOD level. Node types not
   * listed here always render 'full'.
   */
  nodeLOD: Record<string, Partial<Record<ZoomLOD, LODRenderMode>>>;
}

export const SEMANTIC_ZOOM_CONFIG: SemanticZoomConfig = {
  screenThresholds: {
    minimal: 150,
  },
  hysteresis: 10,

  nodeLOD: {
    // Only heavy node types — all others default to 'full' at every level.
    note: { full: 'full', minimal: 'minimal' },
    pdf: { full: 'full', minimal: 'minimal' },
    web: { full: 'full', minimal: 'minimal' },
    // NOTE: `question` is intentionally NOT here. It uses the continuous zoom
    // takeover (V2) instead of the binary boundary: its agent mark slides from
    // the corner to the node centre and the card fades via `NodeTakeoverLayer`
    // / `useNodeTakeover`, driven by a representative-size band rather than this
    // width threshold. See proposals/question-node-zoom-lod-avatar.md.
  },
};

/** Hide provenance chrome once a node is too small to read it meaningfully. */
export const AI_BADGE_MIN_SCREEN_WIDTH = 150;

/**
 * A discrete font tier for `minimal` placeholders.
 *
 * Tiers are selected by a node's representative CANVAS size (see
 * {@link nodeRepresentativeSize}), NOT by its title length — this is what
 * keeps same-size nodes visually in sync and lets bigger nodes read as more
 * important at the same zoom.
 */
export interface MinimalTypographyTier {
  /**
   * Exclusive upper bound of the node's representative canvas size (px) for
   * this tier. Use `Infinity` for the largest tier. Tiers are matched in
   * ascending order.
   */
  maxNodeSize: number;
  /** Canvas-space font size (px) applied to the label at this tier. */
  fontSize: number;
}

/**
 * Font scale for `minimal` placeholders — extensible & pure data. Add,
 * remove, or retune tiers here without touching any render code. Keep it
 * sorted by ascending `maxNodeSize`; the last entry must be `Infinity`.
 */
export const MINIMAL_TYPOGRAPHY_SCALE: readonly MinimalTypographyTier[] = [
  { maxNodeSize: 300, fontSize: 32 },
  { maxNodeSize: 600, fontSize: 52 },
  { maxNodeSize: Infinity, fontSize: 76 },
];

/** Line-height ratio used for `minimal` labels (also drives max-line math). */
export const MINIMAL_LINE_HEIGHT = 1.2;

/**
 * Hard cap on wrapped lines for a `minimal` label. The effective max-lines
 * is the smaller of this cap and however many lines physically fit the
 * node's height, so taller nodes are allowed more lines before ellipsizing.
 */
export const MINIMAL_MAX_LINES = 6;

/**
 * A node's representative size for tier selection: the geometric mean of its
 * width and height, so both a wide-short and a tall-narrow node of equal area
 * land in the same tier.
 */
export function nodeRepresentativeSize(width: number, height: number): number {
  return Math.sqrt(Math.max(0, width) * Math.max(0, height));
}

/** Selects the font tier for a node from its canvas width/height. */
export function selectTypographyTier(
  width: number,
  height: number,
): MinimalTypographyTier {
  const size = nodeRepresentativeSize(width, height);
  for (const tier of MINIMAL_TYPOGRAPHY_SCALE) {
    if (size < tier.maxNodeSize) return tier;
  }
  return MINIMAL_TYPOGRAPHY_SCALE[MINIMAL_TYPOGRAPHY_SCALE.length - 1];
}
