/**
 * Canvas Node Types
 * Node data structures and type guards
 */

import type { AgentMode } from '../agent.js';

// ==================== Basic Node Types ====================

export type CanvasNodeType =
  | 'note'
  | 'text'
  | 'image'
  | 'pdf'
  | 'video'
  | 'web'
  | 'frame';

/**
 * Discriminated union describing how a canvas node was created.
 */
export type NodeOrigin =
  // AI-generated
  | { type: 'ai-research' }
  | { type: 'ai-operate' }
  // User-initiated
  | { type: 'user-created' }
  | { type: 'user-uploaded' }
  | { type: 'user-pasted' }
  | { type: 'user-from-library' }
  | { type: 'user-from-chat'; threadId?: string }
  | { type: 'user-excerpt'; sourceId?: string };

/** All possible values of `NodeOrigin['type']`. */
export type NodeOriginType = NodeOrigin['type'];

/**
 * Normalize a legacy string origin (from older persisted data) to the
 * current object format.  Returns `undefined` for unrecognised values.
 *
 * @deprecated Remove once all stored data has been migrated.
 */
export function normalizeOrigin(raw: unknown): NodeOrigin | undefined {
  if (!raw) return undefined;
  // Already in the new { type: … } format
  if (typeof raw === 'object' && raw !== null && 'type' in raw) {
    return raw as NodeOrigin;
  }
  // Legacy plain-string format → wrap
  if (typeof raw === 'string') {
    return { type: raw } as NodeOrigin;
  }
  return undefined;
}

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

// ==================== Block-Level Provenance ====================

/**
 * Provenance record for a single BlockNote block.
 * Tracks who originally authored the block and any subsequent modifications.
 */
export interface BlockProvenance {
  /** Who originally created this block */
  author: 'ai' | 'user';
  /** Agent mode when AI-authored (omitted for user-authored) */
  agentMode?: AgentMode;
  /** ISO timestamp of creation */
  createdAt: string;
  /** Chronological list of modifications after initial creation */
  modifications?: Array<{
    by: 'ai' | 'user';
    agentMode?: AgentMode;
    at: string;
  }>;
}

/**
 * Map of block ID → provenance.
 * The special key `__all__` is a sentinel used when the server creates/updates
 * content via Markdown (no block IDs available). The client expands this into
 * per-block entries when the editor initializes.
 */
export type BlockProvenanceMap = Record<string, BlockProvenance>;

// ==================== Node Data Types ====================

/** Common fields for all node types */
export interface BaseNodeData {
  /** Node origin/source */
  origin?: NodeOrigin;
  /** Research-related data (only when origin.type === 'ai-research') */
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
  /**
   * When true the node is locked: it cannot be moved, resized, or repositioned
   * by auto-layout. For frame nodes, locking also prevents children from being
   * added, removed, or repositioned.
   */
  locked?: boolean;
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
   * Should be loaded in preference to `content` when `contentJsonSource === content`,
   * which means the JSON was generated from the current markdown and is in sync.
   * When `content` differs from `contentJsonSource` (e.g. edited externally by the
   * AI agent or an external tool), `content` takes precedence and `contentJson` is
   * regenerated from it.
   * Optional: absent for legacy notes or notes created externally.
   */
  contentJson?: string;
  /**
   * The value of `content` at the time `contentJson` was last generated.
   * Used to detect whether `content` has been modified externally since the last
   * editor save, without relying on lossy `blocksToMarkdownLossy` round-trips.
   * When `contentJsonSource === content`, `contentJson` is authoritative.
   */
  contentJsonSource?: string;
  sourceId?: string;
  style?: NodeStyle;
  /**
   * Block-level content provenance map.
   * Keys are BlockNote block IDs, or `__all__` as a sentinel when
   * all blocks share the same provenance (e.g. AI-created content).
   */
  provenance?: BlockProvenanceMap;
  /**
   * Snapshot of `content` taken before the first AI edit in a session.
   * Used to show a Markdown diff of AI changes. Strategy: set once,
   * not overwritten by subsequent AI edits. Cleared on user dismiss or
   * when all AI blocks have been user-modified.
   */
  contentBeforeAI?: string;
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

/** A single highlight annotation on a PDF page. */
export interface PdfHighlight {
  id: string;
  /** 0-based page index */
  pageIndex: number;
  /** Bounding rectangles (normalized 0–1 relative to the page) */
  rects: Array<{ x: number; y: number; width: number; height: number }>;
}

/** PDF node: PDF document that can be ingested */
export interface PdfNodeData extends BaseNodeData {
  type: 'pdf';
  src: string;
  sourceId?: string;
  /** When set, the canvas node displays this image instead of the PDF preview. */
  coverUrl?: string;
  /** Persistent text highlights drawn by the user. */
  highlights?: PdfHighlight[];
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
