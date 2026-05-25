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

// ==================== Block-Level Provenance (Phase 4) ====================

/**
 * Provenance record for a single AI-modified block.
 *
 * Phase 4 (Milkdown migration): provenance is keyed by **block fingerprint**
 * (a stable hash derived from the block's ProseMirror node — see
 * `apps/web/src/utils/blockProvenance.ts`). When the user edits a flagged
 * block, its fingerprint changes and the entry is auto-dropped ("user
 * accepted by editing"). See `docs/milkdown-migration-plan.md` §4.
 */
export interface BlockProvenance {
  /** Stable fingerprint key. */
  key: string;
  /**
   * How the block came to exist:
   *  - `'modified'`: the AI edited an existing block. `baselineMarkdown`
   *    holds the pre-edit content; Reject restores it.
   *  - `'inserted'`: the AI inserted a brand-new block. `baselineMarkdown`
   *    is `''`; Reject deletes the block outright.
   *
   * Optional for backward-compatibility with records persisted before
   * this field existed; treated as `'modified'` when absent.
   */
  kind?: 'modified' | 'inserted';
  /**
   * Markdown of the block as it was right before the AI edit. Empty
   * string for `kind === 'inserted'`.
   */
  baselineMarkdown: string;
  /** ISO timestamp when the AI edit was stamped. */
  at: string;
}

/**
 * Tombstone for a block deleted by AI. Rendered via React portal anchored
 * after the surviving `anchorKey` block (or at doc head when `null`).
 */
export interface DeletedBlockInfo {
  /** Fingerprint the deleted block had at the time of deletion. */
  key: string;
  /** Markdown of the block before deletion. */
  baselineMarkdown: string;
  /**
   * Fingerprint of the surviving block this tombstone hangs after.
   * `null` means the tombstone is at document head.
   */
  anchorKey: string | null;
  /** ISO timestamp when the AI deletion was stamped. */
  at: string;
}

/**
 * Block-level provenance for a note's markdown content.
 *
 * Keys blocks by a content fingerprint (Milkdown / ProseMirror does
 * not expose persistent block ids).
 */
export interface MarkdownProvenance {
  version: 1;
  /** Live AI-modified blocks present in the current doc. */
  blocks: BlockProvenance[];
  /** Tombstones for blocks deleted by AI. */
  deletedBlocks: DeletedBlockInfo[];
}

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
  /**
   * Track index inside the parent frame when that frame is in a grid
   * layout mode. Means the **column index** when the parent is in
   * `column` mode, the **row index** when the parent is in `row`
   * mode, and is ignored for `free` mode and root-level nodes.
   *
   * Persisted so a child stays in its user-chosen lane across re-runs
   * of the layout pass (especially the "no empty track" rebalance).
   */
  frameSlot?: number;
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
  style?: NodeStyle;
  /**
   * Block-level provenance for AI edits.
   * See `apps/web/src/utils/blockProvenance.ts`.
   *
   * Historical records may carry an unrelated shape — the runtime
   * ignores any value that does not parse as `MarkdownProvenance`.
   */
  provenance?: MarkdownProvenance;
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

/**
 * Layout mode applied to a frame's direct children.
 *
 * - `free`   — no layout enforcement; children keep their current
 *              positions (default).
 * - `column` — N columns × ∞ rows. Children stack top-to-bottom inside
 *              each column, left-aligned; column width adapts to the
 *              widest child. Drop column = position under the cursor;
 *              the "no empty column" invariant rebalances when there
 *              are at least as many children as columns.
 * - `row`    — N rows × ∞ columns. Mirror of `column` on the other axis
 *              (children top-aligned within their row).
 */
export const FRAME_LAYOUT_MODES = ['free', 'column', 'row'] as const;
export type FrameLayoutMode = (typeof FRAME_LAYOUT_MODES)[number];

/** Min / max bounds for the track count picker. */
export const FRAME_GRID_MIN_COUNT = 1;
export const FRAME_GRID_MAX_COUNT = 12;
/** Default track count (columns or rows) when switching into a grid mode. */
export const FRAME_GRID_DEFAULT_COUNT = 1;

/** Frame node: container for grouping other nodes */
export interface FrameNodeData extends BaseNodeData {
  type: 'frame';
  /** Layout mode applied to direct children. Defaults to `'free'`. */
  layoutMode?: FrameLayoutMode;
  /**
   * Number of tracks for the active grid mode — interpreted as columns
   * when `layoutMode === 'column'`, as rows when `layoutMode === 'row'`,
   * ignored otherwise. Clamped to [`FRAME_GRID_MIN_COUNT`,
   * `FRAME_GRID_MAX_COUNT`]; defaults to `FRAME_GRID_DEFAULT_COUNT`.
   */
  gridCount?: number;
}

/**
 * One pen-down → pen-up trace inside a {@link SketchNodeData}.
 *
 * Stored in node-local coordinates (origin = node bbox top-left). When
 * the user draws a new stroke close in space + time to an existing
 * sketch node, the new stroke is appended to that node's `strokes`
 * array (see `SketchOverlay.handlePointerUp`); otherwise a fresh node
 * is created with a single-stroke array.
 */
export interface SketchStroke {
  /** Stable id, generated with `createId('stroke')`. */
  id: string;
  /** [x, y, pressure] points in node-local coordinates. */
  points: number[][];
  /** Stroke color — palette token (e.g. `'red'`) or hex string. */
  color: string;
  /**
   * Stroke thickness in flow-space units (matches `perfect-freehand`'s
   * `size` option).
   */
  size: number;
  /**
   * Wall-clock ms at pointer-up. Used by the merge window in
   * `SketchOverlay` to decide whether a new stroke joins this node.
   */
  createdAt: number;
}

/** Sketch node: freehand drawing stored as one or more pressure-sensitive strokes. */
export interface SketchNodeData extends BaseNodeData {
  type: 'sketch';
  /**
   * Strokes painted into this node, in document order (back → front).
   * A live sketch node always has at least one stroke; the eraser deletes
   * the node when the last stroke is removed.
   */
  strokes: SketchStroke[];
  /**
   * Reference bbox in node-local coords — the size at which `strokes`
   * are unscaled. The renderer compares the node's current measured
   * size to this to derive `scaleX` / `scaleY`. Updated whenever the
   * bbox is recomputed (new stroke merged in, eraser deletes a stroke).
   */
  initialSize: { width: number; height: number };
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
