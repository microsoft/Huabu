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

export type NodeOrigin =
  // AI-generated
  | 'research' // Deep Research pipeline
  | 'chat' // Chat agent tool call
  // User-initiated
  | 'user-created' // Toolbar click → blank node on canvas
  | 'user-uploaded' // File upload dialog
  | 'user-pasted' // Cmd+V duplicate of existing node(s)
  | 'user-drag-library' // Dragged from SourceLibrary panel (references an ingested source)
  | 'user-drag-chat'; // Dragged from chat message card (SourceCard URL or BlockNoteCard content)

/** Who set the node label — controls whether auto-title may overwrite it */
export type LabelSource = 'auto' | 'user';

export interface NodeResearchData {
  /** Original research query */
  query: string;
  /** Thread ID of the research session that created this node */
  threadId?: string;
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
  /**
   * Who last set the label.
   * - 'auto': derived from content (H1 / first line). May be overwritten automatically.
   * - 'user': manually set by the user. Auto-title will not overwrite this.
   * Absent means the label was generated at node creation time (treated like 'auto').
   */
  labelSource?: LabelSource;
}

/** Note node: rich content that can be ingested into knowledge base */
export interface NoteNodeData extends BaseNodeData {
  type: 'note';
  /**
   * Canonical Markdown string — the primary, human/AI-readable representation.
   * This is what gets stored in Obsidian vaults and other Markdown-based backends.
   * May be empty for brand-new nodes that have not been saved yet.
   */
  content: string;
  /**
   * Auxiliary BlockNote native JSON (lossless editor representation).
   * Kept in sync with `content`. When this field differs from the BlockNote JSON
   * that would be derived from `content`, `content` (Markdown) takes precedence
   * and `contentJson` is regenerated from it.
   * Optional: absent for legacy notes or notes created externally.
   */
  contentJson?: string;
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
