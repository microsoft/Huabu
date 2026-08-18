// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type {
  CanvasNodeType,
  NodeData,
  NodeStyle,
  NoteNodeData as SharedNoteNodeData,
  TextNodeData as SharedTextNodeData,
  WebNodeData as SharedWebNodeData,
  PdfNodeData as SharedPdfNodeData,
  OfficeNodeData as SharedOfficeNodeData,
  VideoNodeData as SharedVideoNodeData,
  ImageNodeData as SharedImageNodeData,
  AudioNodeData as SharedAudioNodeData,
  FrameNodeData as SharedFrameNodeData,
  SpacePreviewNodeData as SharedSpacePreviewNodeData,
  CanvasRefNodeData as SharedCanvasRefNodeData,
  FrameRefNodeData as SharedFrameRefNodeData,
  NodeRefNodeData as SharedNodeRefNodeData,
  SketchNodeData as SharedSketchNodeData,
  QuestionNodeData as SharedQuestionNodeData,
} from '@huabu/shared';
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
export type CanvasOfficeNodeData = SharedOfficeNodeData & {
  [key: string]: unknown;
};
export type CanvasVideoNodeData = SharedVideoNodeData & {
  [key: string]: unknown;
};
export type CanvasImageNodeData = SharedImageNodeData & {
  [key: string]: unknown;
};
export type CanvasAudioNodeData = SharedAudioNodeData & {
  [key: string]: unknown;
};
export type CanvasFrameNodeData = SharedFrameNodeData & {
  [key: string]: unknown;
};
export type SpacePreviewNodeData = SharedSpacePreviewNodeData & {
  [key: string]: unknown;
};
export type CanvasRefNodeData = SharedCanvasRefNodeData & {
  [key: string]: unknown;
};
export type FrameRefNodeData = SharedFrameRefNodeData & {
  [key: string]: unknown;
};
export type NodeRefNodeData = SharedNodeRefNodeData & {
  [key: string]: unknown;
};
export type CanvasSketchNodeData = SharedSketchNodeData & {
  [key: string]: unknown;
};
export type CanvasQuestionNodeData = SharedQuestionNodeData & {
  [key: string]: unknown;
};

/** Union type for all canvas node data */
export type CanvasNodeData =
  | CanvasNoteNodeData
  | CanvasTextNodeData
  | CanvasWebNodeData
  | CanvasPdfNodeData
  | CanvasOfficeNodeData
  | CanvasVideoNodeData
  | CanvasImageNodeData
  | CanvasAudioNodeData
  | CanvasFrameNodeData
  | SpacePreviewNodeData
  | CanvasRefNodeData
  | FrameRefNodeData
  | NodeRefNodeData
  | CanvasSketchNodeData
  | CanvasQuestionNodeData;

export type CanvasNode = Node<CanvasNodeData, CanvasNodeType>;
