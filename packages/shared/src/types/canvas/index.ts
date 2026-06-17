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
  ColorPickerOption,
} from './color.js';
export {
  ACCENT_PALETTE,
  ACCENT_NONE_TOKEN,
  ACCENT_PICKER_OPTIONS_WITH_TRANSPARENT,
  isAccentToken,
  isHexColor,
  resolveAccent,
  accentName,
} from './color.js';

// Node types
export type {
  CanvasNodeType,
  AgentCreatableNodeType,
  NodeOrigin,
  NodeOriginType,
  NodeStyle,
  NodeFontFamily,
  NodeFontWeight,
  NodeFontStyle,
  NodeTextDecoration,
  BaseNodeData,
  BlockProvenance,
  DeletedBlockInfo,
  MarkdownProvenance,
  NoteNodeData,
  TextNodeData,
  WebNodeData,
  PdfNodeData,
  PdfHighlight,
  OfficeNodeData,
  OfficeFormat,
  VideoNodeData,
  ImageNodeData,
  AudioNodeData,
  FrameNodeData,
  FrameLayoutMode,
  SketchNodeData,
  SketchStroke,
  QuestionNodeData,
  QuestionNodeStatus,
  QuestionInput,
  LabelSource,
  NodeData,
} from './node.js';

export {
  CANVAS_NODE_TYPES,
  AGENT_CREATABLE_NODE_TYPES,
  OFFICE_FORMATS,
  NODE_FONT_FAMILIES,
  NODE_FONT_WEIGHTS,
  NODE_FONT_STYLES,
  FRAME_LAYOUT_MODES,
  FRAME_GRID_MIN_COUNT,
  FRAME_GRID_MAX_COUNT,
  FRAME_GRID_DEFAULT_COUNT,
  isNoteNode,
  isTextNode,
  isMediaNode,
  isAudioNode,
  isOfficeNode,
  isFrameNode,
  isSketchNode,
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
export {
  EDGE_STROKE_WIDTHS,
  EDGE_LINE_TYPES,
  EDGE_LINE_STYLES,
  EDGE_DIRECTIONS,
} from './edge.js';

// CanvasPage types
export type {
  Point,
  Bounds,
  CanvasViewport,
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
export {
  CANVAS_ALIGN_DIRECTIONS,
  UI_ONLY_CANVAS_COMMAND_TYPES,
  AGENT_CANVAS_COMMAND_TYPES,
} from './command.js';

// Execution types
export type {
  CanvasExecutionSource,
  CanvasExecution,
  CanvasCommandFailureReason,
  CanvasCommandResult,
} from './execution.js';
