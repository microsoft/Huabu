// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Zoom-LOD takeover geometry for the question node's agent mark.
 *
 * The mark's SIZE is a CONTINUOUS function of the node's on-screen width, so
 * across a zoom the badge shrinks smoothly with the card it is pinned to — no
 * discrete size swap and no one-shot tween; every frame is the exact size for
 * that zoom. A single {@link collapseProgress} `t ∈ [0,1]` drives it:
 *
 *   t = 0  — node wide enough to read: the card shows and the agent badge sits
 *            at the top-left corner, scaling WITH the card.
 *   0<t<1  — transition band: the badge continuously resizes badge → mark as
 *            the node shrinks.
 *   t = 1  — node too small to read: the card is gone and a centred agent mark
 *            stands in for it. The mark's GLYPH is size-driven (a full agent
 *            avatar down to {@link MARK_FACE_MIN}px, then a solid dot).
 *
 * The discrete {@link QuestionLodStage} is derived from the same width to decide
 * card-body visibility + chrome (it flips once, with hysteresis, at the band
 * start), and the mark's POSITION rides along with it over
 * {@link TAKEOVER_GLIDE_MS} — but it never drives the mark's size. All numbers
 * are pure tuning knobs. Question-tuned for now; lift into a registry if a
 * second node type ever opts into staged takeover.
 */

export type QuestionLodStage = 'readable' | 'collapsed';

/** Screen point in the canvas renderer overlay (px). */
export interface TakeoverPoint {
  x: number;
  y: number;
}

/** Type-agnostic signals handed to the node's mark renderer. */
export interface TakeoverState {
  stage: QuestionLodStage;
  /** Rendered mark diameter (screen px) for this stage/zoom. */
  size: number;
}

/**
 * Node screen WIDTH (px) at/above which the takeover is fully OFF (t = 0): the
 * card body shows and the agent badge rests at the top-left corner.
 */
export const TAKEOVER_START_WIDTH = 64;
/**
 * Node screen WIDTH (px) at/below which the takeover is fully ON (t = 1): the
 * card body is gone and the mark is at its collapsed size. Between this and
 * {@link TAKEOVER_START_WIDTH} the mark continuously resizes badge → mark.
 */
export const TAKEOVER_END_WIDTH = 24;
/** Hysteresis (px) around the body-visibility boundary so it never flickers. */
export const TAKEOVER_HYSTERESIS = 6;

/**
 * Duration (ms) of the mark's corner → centre glide. The glide is driven by the
 * card's visibility, NOT by zoom: the mark must be at the corner for exactly as
 * long as the card is there to hang off, and at the centre — where the node's
 * edges converge — for exactly as long as it is standing in for the whole node.
 * Kept in lockstep with the card's 200ms opacity transition in `index.css`, so
 * the card dissolving and the mark taking its place are one movement.
 */
export const TAKEOVER_GLIDE_MS = 200;

/**
 * Readable-stage badge diameter as a fraction of the node's shorter on-screen
 * side, so the badge stays proportional to the card (a big card gets a big
 * badge) instead of a fixed size that looks like a tiny sticker on a large
 * node. Clamped so a small readable node still shows a legible badge and a huge
 * node's badge stays tidy.
 */
export const BADGE_FRACTION = 0.28;
/** Lower clamp (screen px) for the readable badge. */
export const BADGE_MIN_SIZE = 30;
/** Upper clamp (screen px) for the readable badge. */
export const BADGE_MAX_SIZE = 84;

/**
 * Collapsed mark size (screen px) — a single continuous curve driven by the
 * node's on-screen SHORTER side (min(w,h), the same dimension the badge uses).
 * The mark tracks the node's short side (concave, so it climbs out of the floor
 * quickly then flattens toward the {@link MARK_MAX} cap ≈ the badge floor, so
 * collapsing never pops the size) and floors at {@link MARK_MIN}. Edges follow
 * the mark (see `collapsedRadius`), so it need not fill the footprint.
 */
export const MARK_MIN = 6;
export const MARK_MAX = 30;
/** Node shorter-side (screen px) at/below which the mark sits at {@link MARK_MIN}. */
const MARK_SHORT_MIN = 4;
/** Node shorter-side (screen px) at/above which the mark sits at {@link MARK_MAX}. */
const MARK_SHORT_MAX = 30;
/** Concave easing (<1): climb out of the floor quickly, then flatten. */
const MARK_GAMMA = 0.7;
/**
 * Mark diameter (screen px) at/above which the collapsed mark shows the full
 * agent character; below it it is a clean solid identity dot. Kept low, so the
 * face survives down to a very small size (it stays legible) and only the
 * tiniest marks fall back to a dot.
 */
export const MARK_FACE_MIN = 7;

/** Clamps to `[0,1]`. */
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Continuous collapse progress `t ∈ [0,1]` for the current on-screen width:
 * 0 while the node is wider than {@link TAKEOVER_START_WIDTH} (readable card +
 * corner badge), ramping to 1 by {@link TAKEOVER_END_WIDTH} (collapsed mark).
 * Smoothstep-eased so the resize starts and ends gently instead of at a
 * constant velocity. This is what makes the mark's size track the zoom
 * continuously rather than snapping at a threshold.
 */
export function collapseProgress(nodeScreenW: number): number {
  const raw =
    (TAKEOVER_START_WIDTH - nodeScreenW) /
    (TAKEOVER_START_WIDTH - TAKEOVER_END_WIDTH);
  const t = clamp01(raw);
  // smoothstep: t*t*(3 - 2t)
  return t * t * (3 - 2 * t);
}

/**
 * Collapsed mark diameter (screen px): a single continuous concave curve of the
 * node's shorter on-screen side, from {@link MARK_MIN} up to {@link MARK_MAX}.
 * The glyph (face ↔ dot) is decided separately from the size via
 * {@link MARK_FACE_MIN}, so there is no size discontinuity anywhere.
 */
export function collapsedMarkSize(
  nodeScreenW: number,
  nodeScreenH: number,
): number {
  const shortSide = Math.min(
    Math.max(0, nodeScreenW),
    Math.max(0, nodeScreenH),
  );
  const n = clamp01(
    (shortSide - MARK_SHORT_MIN) / (MARK_SHORT_MAX - MARK_SHORT_MIN),
  );
  return MARK_MIN + (MARK_MAX - MARK_MIN) * Math.pow(n, MARK_GAMMA);
}

/**
 * Readable-end badge diameter (screen px) — the mark's size at `t = 0`.
 * Proportional to the node's shorter side (so it scales with the card, both
 * with zoom AND with the node's own size), with min/max clamps.
 */
export function badgeSizeForNode(
  nodeScreenW: number,
  nodeScreenH: number,
): number {
  return Math.max(
    BADGE_MIN_SIZE,
    Math.min(
      BADGE_MAX_SIZE,
      BADGE_FRACTION * Math.min(nodeScreenW, nodeScreenH),
    ),
  );
}

/**
 * The mark's rect relative to the node's own top-left, in canvas units, eased
 * from the full footprint at `glide = 0` to the mark's bounding square at 1.
 *
 * `glide` is clamped rather than trusted. Every length here is a screen-px
 * constant divided by `zoom`, so an out-of-range glide does not merely
 * overshoot — it scales those lengths without bound, and the result is written
 * straight into a CSS offset. A caller must also pass the LIVE zoom of the
 * frame it is laying out: the error there is multiplicative in the ratio of the
 * two zooms.
 */
export function localMarkRect(
  width: number,
  height: number,
  zoom: number,
  glide: number,
): { x: number; y: number; width: number; height: number } {
  const g = clamp01(glide);
  const screenW = width * zoom;
  const screenH = height * zoom;
  const badge = badgeSizeForNode(screenW, screenH);
  const size = lerp(
    badge,
    collapsedMarkSize(screenW, screenH),
    collapseProgress(screenW),
  );
  const radius = size / (2 * zoom);
  const cx = lerp((badge * 0.3) / zoom, width / 2, g);
  const cy = lerp((badge * 0.05) / zoom, height / 2, g);
  return {
    x: lerp(0, cx - radius, g),
    y: lerp(0, cy - radius, g),
    width: lerp(width, radius * 2, g),
    height: lerp(height, radius * 2, g),
  };
}

/**
 * Resolves the crisp card-body stage for the current on-screen width. This
 * shows/hides the card body, picks chrome, and drives the mark's corner →
 * centre glide — the mark's SIZE comes from the continuous
 * {@link collapseProgress}, not from here. The body flips off once the node
 * passes the takeover band start ({@link TAKEOVER_START_WIDTH}), with
 * hysteresis so it never flickers at the edge. The face ↔ dot glyph is NOT a
 * stage — it is size-driven in the mark itself (see {@link MARK_FACE_MIN}).
 */
export function resolveQuestionStage(
  prev: QuestionLodStage,
  nodeScreenW: number,
): QuestionLodStage {
  const w = nodeScreenW;
  const S = TAKEOVER_START_WIDTH;
  const H = TAKEOVER_HYSTERESIS;
  if (prev === 'readable') return w < S - H ? 'collapsed' : 'readable';
  return w >= S + H ? 'readable' : 'collapsed';
}
