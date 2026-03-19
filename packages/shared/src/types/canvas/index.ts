/**
 * Canvas Types - Unified Exports
 *
 * This module provides a clean interface to all canvas-related types.
 * Types are organized into logical modules:
 * - node.ts: Node data structures and type guards
 * - edge.ts: Edge types and styling
 * - source.ts: Knowledge source and ingestion types
 * - layout.ts: Layout calculation types
 * - operation.ts: Canvas operation types (for programmatic manipulation)
 * - canvas-api.ts: REST API request/response types
 */

// Node types
export type {
  CanvasNodeType,
  NodeOrigin,
  NodeOriginType,
  NodeResearchData,
  NodeStyle,
  BaseNodeData,
  NoteNodeData,
  TextNodeData,
  WebNodeData,
  PdfNodeData,
  PdfHighlight,
  VideoNodeData,
  ImageNodeData,
  FrameNodeData,
  NodeData,
} from './node.js';

export {
  isNoteNode,
  isTextNode,
  isMediaNode,
  isFrameNode,
  hasSourceId,
  normalizeOrigin,
} from './node.js';

// Edge types
export type { EdgeStyle } from './edge.js';

// Source types
export type {
  UpsertNodeRequest,
  UpsertNodeResponse,
  DeleteNodeResponse,
  ResolveLabelRequest,
  ResolveLabelResponse,
} from './source.js';

// Layout types
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
  CanvasSize,
  CanvasAlignDirection,
  CanvasAutoLayoutScope,
  CanvasAutoLayoutOptions,
  CanvasNodeCreateInput,
  CanvasNodeDataMergePatch,
  CanvasNodeParentUpdate,
  CanvasNodeGeometryUpdate,
  CanvasNodeLockUpdate,
  CanvasEdgeCreateInput,
  CanvasCommand,
  CanvasCommandType,
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
  CanvasVersionMismatchError,
  UpdateCanvasStateParams,
  UpdateCanvasStateResult,
  ExportedSource,
  ExportedArtifact,
  CanvasExportBundle,
  ImportCanvasResponse,
  CanvasSummary,
  ListCanvasesResponse,
  CreateCanvasRequest,
  CreateCanvasResponse,
} from './canvas-api.js';
