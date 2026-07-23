/**
 * Zoom-LOD takeover geometry for the question node's agent mark.
 *
 * The mark's SIZE and POSITION are a CONTINUOUS function of the node's
 * on-screen width, so across a zoom the badge smoothly shrinks and glides from
 * the readable card's corner into the centred collapsed mark — there is no
 * discrete stage swap and no one-shot tween; every frame is the exact geometry
 * for that zoom. A single {@link collapseProgress} `t ∈ [0,1]` drives it:
 *
 *   t = 0  — node wide enough to read: the card shows and the agent badge sits
 *            at the top-left corner, scaling WITH the card.
 *   0<t<1  — transition band: the badge continuously moves corner → centre and
 *            resizes badge → mark as the node shrinks.
 *   t = 1  — node too small to read: the card is gone and a centred agent mark
 *            stands in for it. The mark's GLYPH is size-driven (a full agent
 *            avatar down to {@link MARK_FACE_MIN}px, then a solid dot).
 *
 * The discrete {@link QuestionLodStage} is derived from the same width ONLY to
 * decide card-body visibility + chrome (it flips once, with hysteresis, at the
 * band start); it never drives the mark's size or position. All numbers are
 * pure tuning knobs. Question-tuned for now; lift into a registry if a second
 * node type ever opts into staged takeover.
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
 * card body is gone and the mark sits centred. Between this and
 * {@link TAKEOVER_START_WIDTH} the mark continuously morphs corner → centre.
 */
export const TAKEOVER_END_WIDTH = 24;
/** Hysteresis (px) around the body-visibility boundary so it never flickers. */
export const TAKEOVER_HYSTERESIS = 6;

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

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Continuous collapse progress `t ∈ [0,1]` for the current on-screen width:
 * 0 while the node is wider than {@link TAKEOVER_START_WIDTH} (readable card +
 * corner badge), ramping to 1 by {@link TAKEOVER_END_WIDTH} (centred mark).
 * Smoothstep-eased so the corner → centre glide starts and ends gently instead
 * of at a constant velocity. This is what makes the takeover track the zoom
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
 * Stage-1 badge diameter (screen px). Proportional to the node's shorter side
 * (so it scales with the card, both with zoom AND with the node's own size),
 * with min/max clamps.
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

/** Rendered mark diameter (screen px) for a stage at the current geometry. */
export function markSizeForStage(
  stage: QuestionLodStage,
  nodeScreenW: number,
  nodeScreenH: number,
): number {
  if (stage === 'readable') return badgeSizeForNode(nodeScreenW, nodeScreenH);
  return collapsedMarkSize(nodeScreenW, nodeScreenH);
}

/**
 * Resolves the crisp card-body stage for the current on-screen width. This is
 * ONLY used to show/hide the card body and pick chrome — the mark's size and
 * position come from the continuous {@link collapseProgress}, not from here.
 * The body flips off once the node passes the takeover band start
 * ({@link TAKEOVER_START_WIDTH}), with hysteresis so it never flickers at the
 * edge. The face ↔ dot glyph is NOT a stage — it is size-driven in the mark
 * itself (see {@link MARK_FACE_MIN}).
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
