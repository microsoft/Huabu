/**
 * Canvas Node Types
 * Node data structures and type guards
 */

import type { AccentToken, SurfaceToken } from './color.js';

// ==================== Basic Node Types ====================

/**
 * All node kinds the canvas supports. The `as const` array is the single
 * source of truth — both the TypeScript union and any derived schema must
 * use it so adding/removing a kind propagates without manual sync.
 */
export const CANVAS_NODE_TYPES = [
  'note',
  'text',
  'image',
  'pdf',
  'video',
  'web',
  'frame',
  'sketch',
  'question',
] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

/**
 * Node kinds the agent is allowed to construct via `CREATE_NODES`.
 * Excludes:
 * - `sketch` — produced only by the freehand drawing tool.
 * - `question` — created via the dedicated `CREATE_QUESTION` command,
 *   which carries question-specific fields.
 */
export const AGENT_CREATABLE_NODE_TYPES = [
  'note',
  'text',
  'web',
  'image',
  'pdf',
  'video',
  'frame',
] as const;
export type AgentCreatableNodeType =
  (typeof AGENT_CREATABLE_NODE_TYPES)[number];

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
  // Sketch recognition
  | { type: 'sketch-recognized' };

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
export const NODE_FONT_FAMILIES = ['default', 'serif', 'mono', 'hand'] as const;
export type NodeFontFamily = (typeof NODE_FONT_FAMILIES)[number];

export const NODE_FONT_WEIGHTS = ['normal', 'bold'] as const;
export type NodeFontWeight = (typeof NODE_FONT_WEIGHTS)[number];

export const NODE_FONT_STYLES = ['normal', 'italic'] as const;
export type NodeFontStyle = (typeof NODE_FONT_STYLES)[number];

export type NodeTextDecoration = 'underline' | 'line-through';

export interface NodeStyle {
  /**
   * Palette token (preferred — e.g. `'transparent'`, `'blue'`) or a
   * literal CSS color string for legacy data / one-off custom colors.
   * Resolved via `resolveSurface` at render time.
   */
  backgroundColor?: SurfaceToken | (string & {});
  /**
   * Accent palette token (preferred) or a literal CSS color string.
   * Resolved via `resolveAccent` at render time.
   */
  textColor?: AccentToken | (string & {});
  /**
   * Accent palette token (e.g. `'purple'`) shown as a top border stripe
   * for visual grouping. `null` / absent means no accent. Legacy hex
   * strings are also accepted and rendered as-is.
   */
  accent?: AccentToken | (string & {});
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
  /** ISO timestamp of creation */
  createdAt: string;
  /** Chronological list of modifications after initial creation */
  modifications?: Array<{
    by: 'ai' | 'user';
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
  /**
   * Server-set hint: the per-node markdown file backing this node was not
   * found on disk during the last GET. Frontend renders a "file missing"
   * banner so the user can recreate it (by typing) or remove the node.
   * Cleared automatically on the next GET once the file is present again.
   * Only meaningful for node types that persist content (note / text).
   */
  contentMissing?: boolean;
  /**
   * Server-set hint: the artifact file referenced by `data.src` was not
   * found on disk during the last GET. Frontend renders a placeholder
   * with a Remove button. Only meaningful for media nodes (pdf / image /
   * video) whose `src` points to a canvas-scoped artifact URL.
   */
  artifactMissing?: boolean;
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

/** Sketch node: freehand drawing stored as pressure-sensitive points */
export interface SketchNodeData extends BaseNodeData {
  type: 'sketch';
  /** Array of [x, y, pressure] points in local node coordinates */
  points: number[][];
  /** Original bounding box size when the stroke was created */
  initialSize: { width: number; height: number };
  /** Stroke color (hex). Defaults to black when omitted. */
  strokeColor?: string;
  /**
   * Stroke thickness in flow-space units (matches `perfect-freehand`'s
   * `size` option). Defaults to `4` when omitted, which is the historical
   * value the renderer used before the field existed.
   */
  strokeSize?: number;
  /**
   * True after the intent pipeline has consumed this sketch. The
   * renderer no longer changes appearance based on this marker; it is kept
   * as bookkeeping (analytics, future migrations).
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
 * Discriminated on `kind` — add new modalities (sketch, voice, etc.) here.
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
  | SketchNodeData
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

export function isSketchNode(data: NodeData): data is SketchNodeData {
  return data.type === 'sketch';
}

export function isQuestionNode(data: NodeData): data is QuestionNodeData {
  return data.type === 'question';
}
