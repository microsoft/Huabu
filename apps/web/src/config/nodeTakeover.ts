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

/** Node screen WIDTH (px) at/above which the card stays readable (stage 1). */
export const STAGE_READABLE_MIN_WIDTH = 150;
/** Hysteresis (px) around the readable boundary. */
export const STAGE_READABLE_HYSTERESIS = 12;

/** Avatar screen size (px) below which the mark collapses to a dot (stage 3). */
export const STAGE_DOT_THRESHOLD = 22;
/** Hysteresis (px) around the dot boundary. */
export const STAGE_DOT_HYSTERESIS = 3;

/**
 * Stage-1 badge size in CANVAS px. The rendered badge is `BADGE_CANVAS_SIZE ×
 * zoom`, so it scales together with the card instead of staying a constant
 * screen size.
 */
export const BADGE_CANVAS_SIZE = 46;

/**
 * Stage-2/3 stand-in diameter as a fraction of the node's shorter on-screen
 * side. Near 1 so the mark FILLS the node footprint: a smaller mark would sit
 * inside the footprint that edges connect to, leaving the edge visibly detached
 * from the icon.
 */
export const AVATAR_FRACTION = 1.0;
/** Upper clamp (screen px) so a big node's stand-in is never oversized. */
export const AVATAR_MAX_SIZE = 150;
/** Lower clamp (screen px) so a vanishing node still shows a visible dot. */
export const DOT_MIN_SIZE = 12;

/** Stage-1 badge diameter (screen px) — scales with the card via zoom. */
export function badgeSizeForZoom(zoom: number): number {
  return BADGE_CANVAS_SIZE * zoom;
}

/** Unclamped stage-2 avatar diameter (screen px) — used for boundary tests. */
export function rawAvatarSize(
  nodeScreenW: number,
  nodeScreenH: number,
): number {
  return AVATAR_FRACTION * Math.min(nodeScreenW, nodeScreenH);
}

/** Rendered mark diameter (screen px) for a stage at the current geometry. */
export function markSizeForStage(
  stage: QuestionLodStage,
  zoom: number,
  nodeScreenW: number,
  nodeScreenH: number,
): number {
  if (stage === 'readable') return badgeSizeForZoom(zoom);
  return Math.max(
    DOT_MIN_SIZE,
    Math.min(AVATAR_MAX_SIZE, rawAvatarSize(nodeScreenW, nodeScreenH)),
  );
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
