/**
 * Canvas Node Types
 * Node data structures and type guards
 */

// ==================== Basic Node Types ====================

export type CanvasNodeType =
  | 'note'
  | 'text'
  | 'image'
  | 'pdf'
  | 'video'
  | 'web'
  | 'frame';

export type NodeOrigin = 'user' | 'research' | 'chat';

export interface NodeResearchData {
  /** Original research query */
  query: string;
  /** Research session ID (for grouping) */
  sessionId?: string;
  /** Related node IDs (for auto-connecting) */
  relatedNodeIds?: string[];
}

export interface NodeStyle {
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string; // 'underline' | 'line-through' | both
  align?: 'top-left' | 'center';
}

// ==================== Node Data Types ====================

/** Common fields for all node types */
export interface BaseNodeData {
  /** Node origin/source */
  origin?: NodeOrigin;
  /** Research-related data (only when origin === 'research') */
  research?: NodeResearchData;
  /** Display label */
  label?: string;
}

/** Note node: rich content that can be ingested into knowledge base */
export interface NoteNodeData extends BaseNodeData {
  type: 'note';
  content: string;
  sourceId?: string;
  style?: NodeStyle;
}

/** Text node: simple styled text (not ingested) */
export interface TextNodeData extends BaseNodeData {
  type: 'text';
  content: string;
  style?: NodeStyle;
}

/** Web page node: URL-based content that can be ingested */
export interface WebNodeData extends BaseNodeData {
  type: 'web';
  src: string;
  sourceId?: string;
}

/** PDF node: PDF document that can be ingested */
export interface PdfNodeData extends BaseNodeData {
  type: 'pdf';
  src: string;
  sourceId?: string;
  /** Whether PDF is expanded (showing full content vs preview) */
  isExpanded?: boolean;
}

/** Video node: video content */
export interface VideoNodeData extends BaseNodeData {
  type: 'video';
  src: string;
  sourceId?: string;
}

/** Image node: image content */
export interface ImageNodeData extends BaseNodeData {
  type: 'image';
  src: string;
  sourceId?: string;
}

/** Frame node: container for grouping other nodes */
export interface FrameNodeData extends BaseNodeData {
  type: 'frame';
  locked?: boolean;
}

/**
 * Discriminated union of all node data types.
 * Use the 'type' field to narrow down to specific node type.
 */
export type NodeData =
  | NoteNodeData
  | TextNodeData
  | WebNodeData
  | PdfNodeData
  | VideoNodeData
  | ImageNodeData
  | FrameNodeData;

// ==================== Type Guards ====================

export function isNoteNode(data: NodeData): data is NoteNodeData {
  return data.type === 'note';
}

export function isTextNode(data: NodeData): data is TextNodeData {
  return data.type === 'text';
}

export function isMediaNode(
  data: NodeData,
): data is WebNodeData | PdfNodeData | VideoNodeData | ImageNodeData {
  return ['web', 'pdf', 'video', 'image'].includes(data.type);
}

export function isFrameNode(data: NodeData): data is FrameNodeData {
  return data.type === 'frame';
}

export function hasSourceId(
  data: NodeData,
): data is
  | NoteNodeData
  | WebNodeData
  | PdfNodeData
  | VideoNodeData
  | ImageNodeData {
  return 'sourceId' in data;
}
