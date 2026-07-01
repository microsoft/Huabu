/**
 * @sediment/shared/canvas-engine — pure, server-portable canvas command engine.
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
  fingerprintNodeFields,
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

// ── Frame grid layout (column / row child packing) ───────────────────────
// The engine no longer ships a fallback layout for free-form nodes — every
// caller must commit to an explicit `position` in `CREATE_NODES` /
// `CREATE_QUESTION`. The only structured layout that still lives here is
// the column / row child packing for `frame` nodes.
export {
  applyColumnLayout,
  applyRowLayout,
  applyStructuredFrameRelayout,
  clampGridCount,
  readFrameGridConfig,
  pickColumnDropTarget,
  pickRowDropTarget,
  describeStructuredDropZone,
  type FrameGridLayoutResult,
  type StructuredDropTarget,
  type StructuredDropZone,
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
export {
  getNodeDefaultSize,
  getNodeSize,
  getLayoutNodeSize,
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
  type UnframeResult,
  type FrameNodesOptions,
  type FrameNodesResult,
  type AutoFrameByOverlapOptions,
  type AutoUnframeByNonOverlapOptions,
  type FrameNodesInRectOptions,
  type FrameNodesInRectResult,
  type FitFrameOptions,
  type FrameFitResult,
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
  getFrameSizing,
  moveNodeOutOfFrame,
} from './frame/index.js';
export {
  DEFAULT_EDGE_STROKE_WIDTH,
  applyEdgeStyle,
  mergeEdgeStyle,
  getSmartHandles,
  rerouteAllEdges,
} from './utils/edge.js';
