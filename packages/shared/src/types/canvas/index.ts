/**
 * Canvas Types - Unified Exports
 *
 * This module provides a clean interface to all canvas-related types.
 * Types are organized into logical modules:
 * - color.ts: Shared color palettes and background color presets
 * - node.ts: Node data structures and type guards
 * - edge.ts: Edge types and styling
 * - layout.ts: CanvasPage calculation types
 * - operation.ts: Canvas operation types (for programmatic manipulation)
 * - canvas-api.ts: REST API request/response types
 */

// Color types
export type {
  PaletteColorValue,
  StrokeColorValue,
  NodeBgColorValue,
} from './color.js';
export { COLOR_PALETTE, STROKE_COLORS, NODE_BG_COLORS } from './color.js';

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

// Operation types
export type {
  CreateNodeParams,
  CreateNodeResult,
  CreateFrameParams,
  CreateEdgeParams,
  CreateEdgeResult,
} from './operation.js';

// Canvas API types
export type {
  GetCanvasResponse,
  PutCanvasRequest,
  PutCanvasResponse,
  DeleteNodeResponse,
  CanvasVersionMismatchError,
  UpdateCanvasStateParams,
  UpdateCanvasStateResult,
  ImportCanvasResponse,
  CanvasSummary,
  ListCanvasesResponse,
  CreateCanvasRequest,
  CreateCanvasResponse,
} from './canvas-api.js';
