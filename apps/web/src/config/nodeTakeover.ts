/**
 * Discrete zoom-LOD staging for the question node's agent mark.
 *
 * The mark has three CRISP resting stages; the continuous morph is only the
 * transition animation between them (owned by `NodeTakeoverLayer`), so whenever
 * the canvas is still the mark is at a clean, fully-resolved stage — never a
 * half-faded / half-sized in-between.
 *
 *   readable — node still large enough to read: the card shows and the agent
 *              badge sits at the top-left corner, scaling WITH the card.
 *   avatar   — node too small to read the text: the card gives way to a centred
 *              agent avatar (a stand-in sized to the node).
 *   dot      — node very small (avatar would be < ~22px): the avatar collapses
 *              to a solid identity dot.
 *
 * Boundaries are driven by the node's on-screen size (zoom × node size) with
 * hysteresis so a stage never flickers while pinching near an edge. All numbers
 * are pure tuning knobs. Question-tuned for now; lift into a registry if a
 * second node type ever opts into staged takeover.
 */

export type QuestionLodStage = 'readable' | 'avatar' | 'dot';

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
 * Node screen WIDTH (px) at/above which the card stays readable (stage 1).
 * Set to ≈ the badge's min size ({@link BADGE_MIN_SIZE}) so the card only gives
 * way to the centred avatar once the corner badge is about as wide as the node
 * itself.
 */
export const STAGE_READABLE_MIN_WIDTH = 30;
/** Hysteresis (px) around the readable boundary. */
export const STAGE_READABLE_HYSTERESIS = 6;

/** Avatar screen size (px) below which the mark collapses to a dot (stage 3). */
export const STAGE_DOT_THRESHOLD = 9;
/** Hysteresis (px) around the dot boundary. */
export const STAGE_DOT_HYSTERESIS = 2;

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
 * Collapsed stand-in size (screen px), driven by the node's on-screen SHORTER
 * side (min(w,h)) — the same dimension the badge uses. Two bands that meet at
 * 14 px, so the size is continuous (no pop) but the glyph still switches:
 *   - short side ≥ {@link MARK_AVATAR_SHORT} → avatar, sized [14, 30]
 *   - short side <  {@link MARK_AVATAR_SHORT} → dot,    sized [10, 14)
 * The avatar cap (30) ≈ the badge floor, so the centred mark is never bigger
 * than the readable corner badge it takes over from. Edges follow the mark (see
 * `collapsedRadius`), so it need not fill the footprint.
 */
export const MARK_DOT_MIN = 10;
export const MARK_DOT_MAX = 14;
export const MARK_AVATAR_MIN = 14;
export const MARK_AVATAR_MAX = 30;
/**
 * Mark diameter (screen px) at/above which the stand-in shows the full agent
 * character; below it it is a clean solid identity dot. At the band boundary
 * (14), so dots are [10, 14) and avatars are [14, 30].
 */
export const MARK_FACE_MIN = 14;
/** Node shorter-side (screen px) at/above which the mark is an avatar, else a dot. */
const MARK_AVATAR_SHORT = 14;
/** Node shorter-side (screen px) mapped to {@link MARK_AVATAR_MAX}. */
const MARK_SHORT_MAX = 30;
/** Concave easing (<1) for the avatar band: climb out quickly, then flatten. */
const MARK_GAMMA = 0.55;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Collapsed mark diameter (screen px). Returns a value in the avatar band
 * ([14, 30]) or the dot band ([10, 14)) — the two meet continuously at 14, so
 * the size never pops; only the glyph (dot ↔ face) switches there.
 */
export function collapsedMarkSize(
  nodeScreenW: number,
  nodeScreenH: number,
): number {
  const shortSide = Math.min(
    Math.max(0, nodeScreenW),
    Math.max(0, nodeScreenH),
  );
  if (shortSide >= MARK_AVATAR_SHORT) {
    const n = clamp01(
      (shortSide - MARK_AVATAR_SHORT) / (MARK_SHORT_MAX - MARK_AVATAR_SHORT),
    );
    return (
      MARK_AVATAR_MIN +
      (MARK_AVATAR_MAX - MARK_AVATAR_MIN) * Math.pow(n, MARK_GAMMA)
    );
  }
  const m = clamp01(
    (shortSide - MARK_DOT_MIN) / (MARK_AVATAR_SHORT - MARK_DOT_MIN),
  );
  return MARK_DOT_MIN + (MARK_DOT_MAX - MARK_DOT_MIN) * m;
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

/** Node's shorter on-screen side (px) — drives the avatar↔dot stage boundary. */
export function rawAvatarSize(
  nodeScreenW: number,
  nodeScreenH: number,
): number {
  return Math.min(nodeScreenW, nodeScreenH);
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
 * Resolves the crisp stage for the current on-screen geometry, keeping the
 * previous stage unless the size has crossed a boundary by more than the
 * hysteresis buffer. `readable ↔ avatar` switches on node width (text
 * legibility); `avatar ↔ dot` switches on the avatar's own size.
 */
export function resolveQuestionStage(
  prev: QuestionLodStage,
  nodeScreenW: number,
  nodeScreenH: number,
): QuestionLodStage {
  const w = nodeScreenW;
  const avatar = rawAvatarSize(nodeScreenW, nodeScreenH);
  const R = STAGE_READABLE_MIN_WIDTH;
  const Rh = STAGE_READABLE_HYSTERESIS;
  const D = STAGE_DOT_THRESHOLD;
  const Dh = STAGE_DOT_HYSTERESIS;

  switch (prev) {
    case 'readable':
      if (w < R - Rh) return avatar < D - Dh ? 'dot' : 'avatar';
      return 'readable';
    case 'dot':
      if (avatar > D + Dh) return w >= R + Rh ? 'readable' : 'avatar';
      return 'dot';
    default: // avatar
      if (w >= R + Rh) return 'readable';
      if (avatar < D - Dh) return 'dot';
      return 'avatar';
  }
}
