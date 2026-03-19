import type {
  CanvasNodeType,
  NodeData,
  NodeStyle,
  NoteNodeData as SharedNoteNodeData,
  TextNodeData as SharedTextNodeData,
  WebNodeData as SharedWebNodeData,
  PdfNodeData as SharedPdfNodeData,
  VideoNodeData as SharedVideoNodeData,
  ImageNodeData as SharedImageNodeData,
  FrameNodeData as SharedFrameNodeData,
} from '@sediment/shared';
import type { Node } from '@xyflow/react';

export type { CanvasNodeType, NodeData, NodeStyle };

/**
 * Canvas-specific node data types with index signatures for ReactFlow compatibility.
 * ReactFlow requires Record<string, unknown> for node data.
 */
export type CanvasNoteNodeData = SharedNoteNodeData & {
  [key: string]: unknown;
};
export type CanvasTextNodeData = SharedTextNodeData & {
  [key: string]: unknown;
};
export type CanvasWebNodeData = SharedWebNodeData & { [key: string]: unknown };
export type CanvasPdfNodeData = SharedPdfNodeData & { [key: string]: unknown };
export type CanvasVideoNodeData = SharedVideoNodeData & {
  [key: string]: unknown;
};
export type CanvasImageNodeData = SharedImageNodeData & {
  [key: string]: unknown;
};
export type CanvasFrameNodeData = SharedFrameNodeData & {
  [key: string]: unknown;
};

/** Union type for all canvas node data */
export type CanvasNodeData =
  | CanvasNoteNodeData
  | CanvasTextNodeData
  | CanvasWebNodeData
  | CanvasPdfNodeData
  | CanvasVideoNodeData
  | CanvasImageNodeData
  | CanvasFrameNodeData;

export type CanvasNode = Node<CanvasNodeData, CanvasNodeType>;
