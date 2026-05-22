/**
 * Frame subsystem - public surface
 *
 * The internal split is:
 * - `tree.ts`      - generic parent/child + coordinate primitives
 * - `geometry.ts`  - private rectangle / overlap helpers + shared Options types
 * - `detection.ts` - pure read-only predicates ("would X happen?")
 * - `mutation.ts`  - operations that return new nodes/edges arrays
 * - `fit.ts`       - frame auto-resize (compute + apply, with cascade)
 *
 * Consumers should import from this barrel.
 */

export type { NestableNode } from './tree.js';
export {
  createAbsolutePositionGetter,
  getAbsolutePosition,
  getDescendantIds,
  indexById,
  normalizeTreeOrder,
} from './tree.js';

export type {
  AutoFrameByOverlapOptions,
  AutoUnframeByNonOverlapOptions,
} from './geometry.js';

export { findFrameAtPoint, wouldAutoFrame, wouldUnframe } from './detection.js';

export type {
  FrameNodesInRectOptions,
  FrameNodesInRectResult,
  FrameNodesOptions,
  FrameNodesResult,
  UnframeResult,
} from './mutation.js';
export {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  frameNodes,
  frameNodesInRect,
  moveNodeIntoFrame,
  moveNodeOutOfFrame,
  unframe,
} from './mutation.js';

export type { FitFrameOptions, FrameFitResult } from './fit.js';
export { computeFrameFit, fitFrameToChildren, fitFrames } from './fit.js';
