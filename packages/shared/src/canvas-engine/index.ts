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
} from './runtime.js';

// ── Pure preprocessing predicates ────────────────────────────────────────
export { needsPreprocessing, shouldPreprocessOnUpdate } from './preprocess.js';

// ── Command registry (handler / meta maps) ────────────────────────────────
export {
  HANDLERS,
  COMMAND_META,
  type CommandHandler,
  type CommandHandlerResult,
  type CommandDefinition,
} from './commands/index.js';

// ── Auto-layout ───────────────────────────────────────────────────────────
// NOTE: We intentionally do NOT re-export the layout coordinator entry
// point (`placeNode`, `DEFAULT_LAYOUT_OPTIONS`) from this barrel. Those
// eagerly pull in cytoscape + cytoscape-fcose +
// cytoscape-layout-utilities, the last of which references `window` at
// module-load time and crashes Node-only test runs. Command handlers that
// need them import `./autoLayout/index.js` directly; web/server consumers
// only need the lighter pieces below.
export {
  applyLayoutResult,
  LAYOUT_ANIMATION_DURATION_MS,
  type ApplyOptions,
} from './autoLayout/applier.js';
export type {
  LayoutOptions,
  LayoutResult,
  LayoutGraph,
} from './autoLayout/types.js';

// ── Pure utilities re-exported for web consumers ──────────────────────────
export { GRID_SIZE, FRAME_PADDING, snapToGrid } from './utils/constants.js';
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
  moveNodeOutOfFrame,
} from './utils/frame.js';
export {
  DEFAULT_EDGE_STROKE_WIDTH,
  applyEdgeStyle,
  mergeEdgeStyle,
  getSmartHandles,
  rerouteAllEdges,
} from './utils/edge.js';
