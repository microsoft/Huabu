/**
 * Agent avatar level-of-detail — the size curve and detail tiers used when an
 * agent avatar stands in for a node as the canvas zooms out.
 *
 * Prototyped in the `AgentNodePlaygroundPage` zoom-LOD lab and lifted here so
 * the question node's minimal (zoomed-out) stand-in and any future identity
 * surface share one source of truth. All numbers are pure tuning knobs.
 *
 * Companion to {@link file://./semanticZoom.ts}: `semanticZoom` decides WHEN a
 * node collapses to its minimal form; this module decides how big the avatar
 * is at that form and how much detail it can carry at that pixel size.
 */

/** Smallest avatar diameter (px). The floor keeps a legible dot even as the
 * node itself shrinks past it — the dot then reads as the node's stand-in. */
export const AVATAR_MIN_DOT_PX = 14;
/** Largest avatar diameter (px) — the curve never exceeds this, so a zoomed-in
 * avatar can never overwhelm (or overflow) a large node. */
export const AVATAR_MAX_PX = 88;

/** Representative node screen size (√w·h) mapped to {@link AVATAR_MIN_DOT_PX}. */
const AVATAR_NODE_REP_MIN = 24;
/** Representative node screen size (√w·h) mapped to {@link AVATAR_MAX_PX}. */
const AVATAR_NODE_REP_MAX = 520;
/** Concave easing (<1): climb out of the dot quickly, then flatten. */
const AVATAR_GAMMA = 0.7;

/** Detail tiers by rendered avatar size (px). */
export type AvatarDetail = 'dot' | 'silhouette' | 'full';
/** Below this the avatar is a solid identity dot (face turns to mush). */
export const AVATAR_DOT_MAX = 18;
/** At/above this the avatar draws its face; between the two it is a silhouette. */
export const AVATAR_FACE_MIN = 24;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Maps a node's on-screen size to an avatar diameter along a concave curve:
 * the avatar grows with the node when zoomed in (up to {@link AVATAR_MAX_PX})
 * and eases toward {@link AVATAR_MIN_DOT_PX} when zoomed out. Uses the geometric
 * mean of width/height so a wide-short and a tall-narrow node of equal area
 * land on the same size — matching the semantic-zoom typography philosophy.
 */
export function avatarSizeForNode(screenW: number, screenH: number): number {
  const rep = Math.sqrt(Math.max(0, screenW) * Math.max(0, screenH));
  const n = clamp01(
    (rep - AVATAR_NODE_REP_MIN) / (AVATAR_NODE_REP_MAX - AVATAR_NODE_REP_MIN),
  );
  const eased = Math.pow(n, AVATAR_GAMMA);
  return Math.round(
    AVATAR_MIN_DOT_PX + (AVATAR_MAX_PX - AVATAR_MIN_DOT_PX) * eased,
  );
}

/** Selects the detail tier for a rendered avatar diameter (px). */
export function resolveAvatarDetail(sizePx: number): AvatarDetail {
  if (sizePx < AVATAR_DOT_MAX) return 'dot';
  if (sizePx < AVATAR_FACE_MIN) return 'silhouette';
  return 'full';
}
