// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Pure barrel for the canvas command utilities.
 *
 * - Pure / server-portable helpers come from the shared canvas-engine.
 * - Web-only helpers live in `./local.ts`.
 *
 * Call sites import from `'@/handler/canvasCommand/utils'` and don't
 * need to know which side of the boundary each function lives on.
 */

export {
  type AlignDirection,
  type SelectionBounds,
  type NestableNode,
  type UnframeResult,
  type FrameNodesOptions,
  type FrameNodesResult,
  type AutoFrameByOverlapOptions,
  type AutoUnframeByNonOverlapOptions,
  type FrameNodesInRectOptions,
  type FrameNodesInRectResult,
  type FitFrameOptions,
  type FrameFitResult,
  alignNodes,
  spreadNodes,
  getSelectionBounds,
  normalizeTreeOrder,
  getAbsolutePosition,
  createAbsolutePositionGetter,
  indexById,
  getDescendantIds,
  unframe,
  autoUnframeNodeByNonOverlap,
  wouldUnframe,
  wouldAutoFrame,
  autoFrameNodeByOverlap,
  frameNodes,
  moveNodeIntoFrame,
  frameNodesInRect,
  findFrameAtPoint,
  computeFrameFit,
  fitFrameToChildren,
  fitFrames,
  moveNodeOutOfFrame,
  getSmartHandles,
  rerouteAllEdges,
} from '@huabu/shared/canvas-engine';

export { toScreenshotDataUrl, captureCanvasScreenshot } from './screenshot';

export {
  getFrameLayoutMode,
  buildStructuredFrameRelayoutCommands,
} from './frameLayout';

export {
  extractNodeRef,
  extractSnippet,
  computeNodeEditDiff,
  pushAction,
  canvasSizeFromStyle,
  getSelectedNodeIds,
  resolveFrameAtPoint,
} from './local';
