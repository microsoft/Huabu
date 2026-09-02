// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @huabu/shared/canvas-engine — pure, server-portable canvas command engine.
 *
 * This subpath export bundles the executor, command handlers, runtime types,
 * auto-layout, and supporting utilities. The package is intentionally free
 * of browser-only runtime dependencies (DOM, ReactFlow runtime, etc.) so
 * the same engine can run in a Node.js context (e.g. headless executor on
 * the server).
 *
 * `@xyflow/react` is allowed for type-only imports (Node / Edge shapes);
 * the runtime entry of that package is forbidden — see `eslint.config.mjs`.
 */

// ── Executor + runtime types ──────────────────────────────────────────────
export {
  executeCanvasCommands,
  type ExecutorOutput,
  type ExecutorOptions,
} from './executor.js';
export type {
  CanvasNode,
  CanvasEdge,
  CanvasReadState,
  CanvasWriteResult,
  PendingEffects,
} from './interfaces.js';

// ── Shared post-commit cleanups (host-agnostic) ───────────────────────────
export {
  applySharedPostEffects,
  applySharedPostEffectsFromWriteResult,
  type SharedPostEffectsInput,
  type SharedPostEffectsOutput,
} from './postEffects.js';

// ── Deltas (server → client wire diff) ────────────────────────────────────
export { type Delta, applyDeltas, invertDelta } from './delta.js';
export {
  diffCanvasState,
  TRANSIENT_NODE_FIELDS,
  TRANSIENT_EDGE_FIELDS,
  stripTransientNodeFields,
  stripTransientEdgeFields,
} from './diff.js';

// ── Change records (delta-derived revert summary) ─────────────────────────
export {
  type CanvasChangeRecord,
  type CanvasChangeKind,
  extractCanvasChanges,
  coalesceChanges,
  fingerprintNodeFields,
  nodeRevision,
  nodeRevisionOf,
  invertDeltas,
} from './change.js';

// ── Command registry (handler / meta maps) ────────────────────────────────
export {
  HANDLERS,
  COMMAND_META,
  type CommandHandler,
  type CommandHandlerResult,
  type CommandDefinition,
} from './commands/index.js';

// ── Frame grid layout (column / row / grid child packing) ───────────────
// The engine no longer ships a fallback layout for free-form nodes — every
// caller must commit to an explicit `position` in `CREATE_NODES`. The only
// structured layout that still lives here is
// the column / row / grid child packing for `frame` nodes.
export {
  applyColumnLayout,
  applyRowLayout,
  applyGridLayout,
  solveStructuredFrameLayout,
  applyStructuredFrameRelayout,
  getStructuredFrameGutterPlan,
  clampGridCount,
  readFrameGridConfig,
  resolveFrameTrackCount,
  pickColumnDropTarget,
  pickRowDropTarget,
  describeStructuredDropZone,
  planStructuredDrop,
  readFrameTrack,
  readFrameGridRow,
  type FrameAxis,
  type FrameGridAxis,
  type FrameGridLayoutResult,
  type StructuredGutterPlan,
  type StructuredGutterSizes,
  type StructuredDropTarget,
  type StructuredDropZone,
  type StructuredDropRequest,
  type StructuredDropAssignment,
  type StructuredDropContext,
  type StructuredDropContextRect,
  type StructuredReflowEntry,
  type DraggedNodeRect,
} from './autoLayout/gridLayout.js';

// ── Pure utilities re-exported for web consumers ──────────────────────────
export {
  GRID_SIZE,
  FRAME_POINTER_CAPTURE_MARGIN,
  snapToGrid,
  paddingFromExtent,
  medianOfChildExtents,
} from './utils/constants.js';
export { stripMarkdown } from './utils/markdown.js';
export { normalizeMathDelimiters } from './provenance/normalizeMathDelimiters.js';
export {
  type AutoHeightFreshness,
  type AutoHeightHintRead,
  type AutoHeightKey,
  type HeightKind,
  type HeightPolicy,
  HEIGHT_LAYOUT_VERSION,
  HEIGHT_QUANTIZATION_STEP,
  NODE_SHELL_INSET,
  autoHeightKey,
  contentScaleFor,
  getHeightPolicy,
  getHeightRefWidth,
  intrinsicToLayoutHeight,
  isAlwaysAutoHeightType,
  isAutoHeightByDefaultType,
  materializeAutoHeight,
  materializeAutoHeights,
  quantizeHeight,
  readAutoHeightHint,
  resolveAutoLayoutHeight,
  resolveHeightMode,
} from './height/index.js';
export {
  getNodeDefaultSize,
  isAlwaysAutoHeightNodeType,
  getNodeSize,
  getLayoutNodeSize,
  getSketchRenderedSize,
} from './utils/nodeSizes.js';
export {
  NODE_TYPE_TO_PREFIX,
  extractLabelNumber,
  generateNextLabel,
  deduplicateLabel,
} from './utils/labels.js';
export {
  type AlignDirection,
  alignNodes,
  spreadNodes,
} from './utils/alignment.js';
export { type SelectionBounds, getSelectionBounds } from './utils/bounds.js';
export {
  type NestableNode,
  type ContainerFitResult,
  type ContainerInsets,
  type FitContainerOptions,
  normalizeTreeOrder,
  getAbsolutePosition,
  createAbsolutePositionGetter,
  indexById,
  getDescendantIds,
  canParentNode,
  isContainerNode,
  moveNodeIntoContainer,
  moveNodeOutOfContainer,
  computeContainerFit,
  applyContainerFit,
  assignNodeZIndices,
  edgeZIndex,
} from './container/index.js';
export {
  type UnframeResult,
  type FrameNodesOptions,
  type FrameNodesResult,
  type AutoFrameByOverlapOptions,
  type AutoUnframeByNonOverlapOptions,
  type FrameNodesInRectOptions,
  type FrameNodesInRectResult,
  type FitFrameOptions,
  type FrameFitResult,
  unframe,
  autoUnframeNodeByNonOverlap,
  wouldUnframe,
  wouldStickToStructuredFrame,
  wouldAutoFrame,
  autoFrameNodeByOverlap,
  frameNodes,
  moveNodeIntoFrame,
  frameNodesInRect,
  findFrameAtPoint,
  computeFrameFit,
  fitFrameToChildren,
  fitFrames,
  projectAffectedFrameGeometry,
  getFrameSizing,
  moveNodeOutOfFrame,
} from './frame/index.js';
export {
  NODE_REF_DEFAULT_HEIGHT,
  NODE_REF_DEFAULT_WIDTH,
  PORTAL_BOTTOM_PADDING,
  PORTAL_DEFAULT_HEIGHT,
  PORTAL_DEFAULT_WIDTH,
  PORTAL_HEADER_INSET,
  PORTAL_SIDE_PADDING,
  fitPortalToChildren,
  fitPortals,
  placePortalNodeRef,
} from './portal/index.js';
export {
  DEFAULT_EDGE_STROKE_TOKEN,
  DEFAULT_EDGE_STROKE_WIDTH,
  applyEdgeStyle,
  mergeEdgeStyle,
  getSmartHandles,
  rerouteAllEdges,
} from './utils/edge.js';

// ── Note block provenance (host-agnostic fingerprint) ─────────────────────
export {
  fingerprintMarkdownBlocks,
  fingerprintMarkdownKeys,
  fingerprintMdastBlock,
  topLevelListItemMarkdown,
  type FingerprintedBlock,
} from './provenance/blockFingerprint.js';
export {
  emptyProvenance,
  isMarkdownProvenance,
  coerceProvenance,
  diffBlocks,
  stampAiEdit,
  computeAiNoteProvenance,
  shiftProvenance,
  dropBlockEntry,
  dismissDeletedBlock,
  acceptAll,
  findBlockEntry,
  findTombstonesAfter,
  type StampInput,
} from './provenance/noteProvenance.js';
