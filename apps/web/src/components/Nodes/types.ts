import type { Node } from '@xyflow/react';

export type CanvasNodeType =
  | 'note'
  | 'text'
  | 'image'
  | 'pdf'
  | 'video'
  | 'web'
  | 'frame';

export type NodeStyle = {
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string; // 'underline' | 'line-through' | both
  align?: 'top-left' | 'center';
};

export type NodeDataProps = {
  src?: string;
  content?: string;
  label?: string;

  // Populated after ingestion; used to look up stored snapshots.
  sourceId?: string;

  // for text node
  style?: NodeStyle;

  // for frame node
  locked?: boolean;

  // node origin/source
  origin?: 'user' | 'research' | 'chat';

  // research-related properties (only when origin === 'research')
  research?: {
    query: string;
    sessionId?: string;
    relatedNodeIds?: string[];
  };
};

export type CreateNodePayload = {
  src?: string;
  label?: string;
  width?: number;
  height?: number;
};

export type CanvasNodeData = NodeDataProps & {
  alt?: string;
};

export type CanvasNode = Node<CanvasNodeData, CanvasNodeType> & {
  isExpanded?: boolean;
};
