/**
 * Canvas Node Types
 * Node data structures and type guards
 */

import type { AgentMode } from '../agent.js';
import type { NodeBgColorValue } from './color.js';

export type { NodeBgColorValue } from './color.js';
export { NODE_BG_COLORS } from './color.js';

// ==================== Basic Node Types ====================

export type CanvasNodeType =
  | 'note'
  | 'text'
  | 'image'
  | 'pdf'
  | 'video'
  | 'web'
  | 'frame'
  | 'annotation'
  | 'question';

/**
 * Discriminated union describing how a canvas node was created.
 */
export type NodeOrigin =
  // AI-generated
  | { type: 'ai-operate' }
  // User-initiated
  | { type: 'user-created' }
  | { type: 'user-uploaded' }
  | { type: 'user-pasted' }
  | { type: 'user-from-library' }
  | { type: 'user-from-chat'; threadId?: string }
  | { type: 'user-excerpt'; excerptFromNodeId?: string }
  // Annotation recognition
  | { type: 'annotation-recognized' };

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
export type LabelSource = 'auto' | 'user' | 'agent';

/** Font family logical names. CSS font stacks are resolved on the UI side. */
export type NodeFontFamily = 'default' | 'serif' | 'mono' | 'hand';

export type NodeFontWeight = 'normal' | 'bold';
export type NodeFontStyle = 'normal' | 'italic';
export type NodeTextDecoration = 'underline' | 'line-through';

export interface NodeStyle {
  backgroundColor?: NodeBgColorValue | (string & {});
  textColor?: string;
  /** Accent color (hex) shown as a top border stripe for visual grouping. */
  accent?: string | null;
  fontFamily?: NodeFontFamily;
  fontWeight?: NodeFontWeight;
  fontStyle?: NodeFontStyle;
  textDecoration?: string; // space-separated NodeTextDecoration values
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
  /**
   * Plain text of this block before AI modified it.
   * Present = has a pending diff to review. Cleared on accept/edit.
   * Empty string means the block was newly added by AI (no prior content).
   */
  baselineText?: string;
  /**
   * When true, this entry represents a block that was deleted by AI.
   * `baselineText` holds the deleted block's original text.
   */
  deleted?: boolean;
  /**
   * For deleted entries: ID of the surviving block after which the
   * deletion occurred. `null` = deletion was at the document start.
   */
  afterBlockId?: string | null;
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
  /**
   * Visual style. Only `accent` and `backgroundColor` are supported on all
   * node types; text-related fields (fontFamily, textColor, etc.) are only
   * used by note and text nodes.
   */
  style?: NodeStyle;
}

/** Note node: rich Markdown content authored on the canvas */
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
  style?: NodeStyle;
  /**
   * Block-level content provenance map.
   * Keys are BlockNote block IDs, or `__all__` as a sentinel when
   * all blocks share the same provenance (e.g. AI-created content).
   */
  provenance?: BlockProvenanceMap;
  /**
   * @deprecated Use `provenance[blockId].baselineText` instead.
   * Kept for backward compatibility with existing persisted data.
   */
  contentBeforeAI?: string;
  /**
   * Last measured intrinsic content height (in CSS pixels, unscaled) of the
   * rendered note body. Persisted as a paint hint so the node can render at
   * its real auto-mode height on the very first frame after mount —
   * including after React Flow virtualization unmounts/remounts the node
   * during zoom/pan, or after a page reload — instead of briefly flashing
   * at the fallback minimum height before the ResizeObserver fires.
   *
   * Written silently (no undo entry) by the note renderer; safe to omit.
   *
   * TODO(view-hint-strip): This is a pure render cache, not content
   * semantics. It currently rides along with the rest of NodeData through
   * the existing persistence pipeline (canvas.filestore writes the whole
   * node JSON to vault). That's harmless today, but if the vault ever
   * gets committed to git or diffed by external tools, the value will
   * churn on every zoom/edit and pollute diffs. When that happens, strip
   * this field at the persistence boundary in
   * `apps/server/src/modules/canvas/canvas.filestore.ts` (delete it from
   * each note node before `JSON.stringify`). If a second view-only field
   * appears (e.g. PDF last-page, image decoded size), promote both into a
   * shared `viewHints` sub-object on `BaseNodeData` and strip that
   * sub-object once instead.
   */
  measuredHeight?: number;
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
  /** When set, the canvas node displays this image instead of the PDF preview. */
  coverUrl?: string;
  /** Persistent text highlights drawn by the user. */
  highlights?: PdfHighlight[];
}

/** Video node: video content */
export interface VideoNodeData extends BaseNodeData {
  type: 'video';
  src: string;
}

/** Image node: image content */
export interface ImageNodeData extends BaseNodeData {
  type: 'image';
  src: string;
}

/** Frame node: container for grouping other nodes */
export interface FrameNodeData extends BaseNodeData {
  type: 'frame';
}

/** Annotation node: freehand drawing stored as pressure-sensitive points */
export interface AnnotationNodeData extends BaseNodeData {
  type: 'annotation';
  /** Array of [x, y, pressure] points in local node coordinates */
  points: number[][];
  /** Original bounding box size when the stroke was created */
  initialSize: { width: number; height: number };
  /** Stroke color (hex) */
  strokeColor?: string;
  /**
   * True after the intent pipeline has consumed this annotation. Executed
   * strokes are dimmed on the canvas instead of being deleted, so the user
   * can still see what they drew.
   */
  executed?: boolean;
}
// ==================== Question Node ====================

/** Execution status of a question node. */
export type QuestionNodeStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'done'
  | 'error';

/**
 * Extensible input union for question nodes.
 * Discriminated on `kind` — add new modalities (annotation, voice, etc.) here.
 */
export type QuestionInput = { kind: 'text'; content: string };

/** Question node: AI interaction medium embedded on canvas. */
export interface QuestionNodeData extends BaseNodeData {
  type: 'question';
  /** User's input (extensible discriminated union). */
  input: QuestionInput;
  /** Current execution status. */
  status: QuestionNodeStatus;
  /** Epoch ms when auto-run triggers. Transient — not persisted. */
  runAt?: number;
  /** Per-node auto-run delay override (seconds). */
  autoRunDelay?: number;
  /** Agent thread ID (set when run starts). */
  threadId?: string;
  /** Error message when status === 'error'. */
  errorMessage?: string;
  /** Short AI response shown on node after completion. */
  responseSummary?: string;
  /** Whether the user has viewed the completed response in the chat panel. */
  viewed?: boolean;
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
  | FrameNodeData
  | AnnotationNodeData
  | QuestionNodeData;

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

export function isAnnotationNode(data: NodeData): data is AnnotationNodeData {
  return data.type === 'annotation';
}

export function isQuestionNode(data: NodeData): data is QuestionNodeData {
  return data.type === 'question';
}
