// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Frame subsystem - public surface
 *
 * The internal split is:
 * - `geometry.ts`  - private rectangle / overlap helpers + shared Options types
 * - `detection.ts` - pure read-only predicates ("would X happen?")
 * - `mutation.ts`  - operations that return new nodes/edges arrays
 * - `fit.ts`       - Frame policy over generic Container fit geometry
 *
 * Consumers should import from this barrel.
 */

// Compatibility re-exports for existing Frame consumers. New generic
// hierarchy code should import from `container/index.ts`.
export type { NestableNode } from '../container/tree.js';
export {
  createAbsolutePositionGetter,
  getAbsolutePosition,
  getDescendantIds,
  indexById,
  normalizeTreeOrder,
} from '../container/tree.js';

export type {
  AutoFrameByOverlapOptions,
  AutoUnframeByNonOverlapOptions,
} from './geometry.js';

export {
  findFrameAtPoint,
  wouldAutoFrame,
  wouldUnframe,
  wouldStickToStructuredFrame,
} from './detection.js';

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
  unframe,
} from './mutation.js';
export {
  moveNodeIntoContainer as moveNodeIntoFrame,
  moveNodeOutOfContainer as moveNodeOutOfFrame,
} from '../container/mutation.js';

export type { FitFrameOptions, FrameFitResult } from './fit.js';
export { computeFrameFit, fitFrameToChildren, fitFrames } from './fit.js';

export type { AffectedFrameProjection } from './projection.js';
export { projectAffectedFrameGeometry } from './projection.js';

export { getFrameSizing } from './sizing.js';

export { assignNodeZIndices, edgeZIndex } from '../container/zorder.js';
