/**
 * Canvas Types - Unified Exports
 *
 * This module provides a clean interface to all canvas-related types.
 * Types are organized into logical modules:
 * - color.ts: Shared color palettes and background color presets
 * - node.ts: Node data structures and type guards
 * - edge.ts: Edge types and styling
 * - layout.ts: CanvasPage calculation types
 * - command.ts / execution.ts: Canvas command schema and execution layer
 */

// Color types
export type {
  AccentEntry,
  AccentToken,
  AccentValue,
  SurfaceEntry,
  SurfaceToken,
  SurfaceValue,
} from './color.js';
export {
  ACCENT_PALETTE,
  SURFACE_PALETTE,
  isAccentToken,
  isSurfaceToken,
  isHexColor,
  resolveAccent,
  resolveSurface,
  accentName,
  surfaceName,
} from './color.js';

// Node types
export type {
  CanvasNodeType,
  NodeOrigin,
  NodeOriginType,
  NodeStyle,
  NodeFontFamily,
  NodeFontWeight,
  NodeFontStyle,
  NodeTextDecoration,
  BaseNodeData,
  BlockProvenance,
  BlockProvenanceMap,
  NoteNodeData,
  TextNodeData,
  WebNodeData,
  PdfNodeData,
  PdfHighlight,
  VideoNodeData,
  ImageNodeData,
  FrameNodeData,
  AnnotationNodeData,
  QuestionNodeData,
  QuestionNodeStatus,
  QuestionInput,
  NodeData,
} from './node.js';

export {
  isNoteNode,
  isTextNode,
  isMediaNode,
  isFrameNode,
  isAnnotationNode,
  isQuestionNode,
  normalizeOrigin,
} from './node.js';

// Edge types
export type {
  EdgeStyle,
  EdgeLineType,
  EdgeLineStyle,
  EdgeDirection,
  EdgeStrokeWidth,
} from './edge.js';
export { EDGE_STROKE_WIDTHS } from './edge.js';

// CanvasPage types
export type {
  Point,
  Bounds,
  LayoutStrategy,
  LayoutConfig,
  PlacementStrategy,
  CalculateLayoutParams,
  LayoutResult,
} from './layout.js';

// Command types
export type {
  CanvasNodeId,
  CanvasEdgeId,
  CanvasEdgeRef,
  NodeSize,
  CanvasAlignDirection,
  CanvasAutoLayoutScope,
  CanvasAutoLayoutOptions,
  CanvasNodeCreateInput,
  CanvasNodeDataMergePatch,
  CanvasNodeParentUpdate,
  CanvasNodeGeometryUpdate,
  CanvasNodeLockUpdate,
  CanvasEdgeCreateInput,
  CanvasEdgeStylePatch,
  CanvasCommand,
  CanvasCommandType,
  UiOnlyCanvasCommandType,
  AgentCanvasCommand,
  AgentCanvasCommandType,
} from './command.js';

// Execution types
export type {
  CanvasExecutionSource,
  CanvasExecution,
  CanvasCommandFailureReason,
  CanvasCommandResult,
} from './execution.js';
