// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas Node Types
 * Node data structures and type guards
 */

import type { AccentToken } from './color.js';
import type { AgentMode } from '../agent/agent.js';
import type { AgentBinding } from '../api/acp.js';
import type { AgentIcon } from '../api/agent-profile.js';
import type { InteractiveViewDefinitionV1 } from '../api/interactive-view.js';

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
  'office',
  'video',
  'audio',
  'web',
  'frame',
  'spacePreview',
  'canvasRef',
  'frameRef',
  'nodeRef',
  'sketch',
  'question',
] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

/**
 * Node kinds the agent is allowed to construct via `CREATE_NODES`.
 * Excludes:
 * - `sketch` — produced only by the freehand drawing tool.
 * - `spacePreview` — created only by the user-facing target picker or World host operations.
 * - `canvasRef` / `frameRef` / `nodeRef` — created only by legacy World host operations.
 */
export const AGENT_CREATABLE_NODE_TYPES = [
  'note',
  'text',
  'web',
  'image',
  'pdf',
  'office',
  'video',
  'frame',
  'question',
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
  /**
   * Legacy only — stamped by the sketch gesture recogniser, which was
   * removed. Kept so nodes saved before that removal still deserialize;
   * nothing produces it today.
   */
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
   * Single color knob for the node. Accent palette token (e.g.
   * `'purple'`) or — for legacy data only — a literal CSS color string;
   * resolved via `resolveAccent` at render time. `null` / absent means
   * no accent (renderer falls back to the neutral surface).
   *
   * Drives the node's **border**, **fill tint**, and **text tint** in
   * one shot via `accentTokens` on the web side. The previous
   * `backgroundColor` / `textColor` siblings were removed in 2026-06-17
   * so the three layers cannot fall out of sync.
   */
  accent?: AccentToken | (string & {});
  fontFamily?: NodeFontFamily;
  fontWeight?: NodeFontWeight;
  fontStyle?: NodeFontStyle;
  textDecoration?: string; // space-separated NodeTextDecoration values
  /**
   * Locked font size (px) for text-flow nodes (TextNode, QuestionNode).
   *
   * Captured when the user finishes a resize gesture: the binary-searched
   * "fits-the-box" font size is stored here and reused on subsequent
   * renders, so typing/deleting only grows/shrinks the node height, not
   * the font size. Absent value means "use the node type's default font
   * size" (typically 16px).
   */
  fontSize?: number;
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
   * Visual style. `accent` is supported on every node type and is the
   * single source of color (drives border + fill + text tint via
   * `accentTokens`). Font fields apply only to text-bearing nodes
   * (note / text / question).
   */
  style?: NodeStyle;
  /**
   * Server-set hint: the per-node markdown file backing this node was not
   * found on disk during the last GET. Frontend renders the shared
   * non-editable missing-file state and refuses automatic writes that could
   * silently recreate it. Cleared on the next GET once the file is present.
   * Meaningful for every node type backed by a markdown sidecar.
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
   * Server-set hint: more than one markdown sidecar on disk currently
   * claims this node's id (a failed rename or an external copy). The
   * node still renders (the index keeps the last-scanned file), but the
   * frontend surfaces a non-blocking badge so the user resolves the
   * duplicate. Writes to this node are refused until then. Cleared
   * automatically on the next GET once the duplicate is gone.
   */
  contentDuplicate?: boolean;
  /**
   * Server-set hint paired with {@link contentDuplicate}: the list of
   * sidecar filenames on disk that currently claim this node's id, so
   * the frontend can show the user exactly which files collide and let
   * them keep one / delete the rest. Empty / absent when not duplicated.
   */
  duplicateFiles?: string[];
  /**
   * Column index inside a parent Frame laid out in `column` or `grid`
   * mode. Ignored by `free` and `row` layouts and by root-level nodes.
   *
   * Persisted so a child stays in its user-chosen column across re-runs
   * of the layout pass (especially the "no empty track" rebalance).
   * Absent on a child the solver has never placed — entering a
   * structured mode seeds it from the child's on-screen position, which
   * is the only statement of intent a hand-arranged layout carries.
   *
   * Each structured mode addresses the axes it actually has, and every
   * field is named after its axis: `column` uses this, `row` uses
   * {@link frameRow}, and `grid` — being two-dimensional — uses both as
   * a persistent cell. Switching `column` → `grid` therefore carries the
   * column over untranslated.
   */
  frameColumn?: number;
  /**
   * Row index inside a parent Frame laid out in `row` or `grid` mode.
   * Ignored by `free` and `column` layouts and by root-level nodes. See
   * {@link frameColumn} for how the two combine.
   *
   * Rows in `grid` are allowed to be sparse — a blank cell means
   * something there — but the solver allocates one row band per index,
   * so an index far beyond the frame's child count is clamped rather
   * than honoured.
   */
  frameRow?: number;
  /**
   * Legacy single track index, written by builds before the axes were
   * split into {@link frameColumn} / {@link frameRow}. It meant the
   * column index under `column` / `grid` and the row index under `row`,
   * which is exactly the mode-dependent reading the split removed.
   *
   * Read-only compatibility: each solver falls back to it on its own
   * axis and writes only the new field, so a Frame sheds this on its
   * first relayout. Delete once no unopened pre-split canvases remain.
   *
   * @deprecated Use {@link frameColumn} / {@link frameRow}.
   */
  frameSlot?: number;
  /**
   * Who owns this node's height.
   *
   * - `'auto'` — the height is derived from rendered content. The number
   *   in `style.height` is materialized from {@link autoHeight}, not
   *   authored, and carries no authority on disk.
   * - `'fixed'` — the height in `style.height` is authored geometry (a
   *   creation default or a resize gesture) and content never moves it.
   *
   * Authored state: toggling it is a user intent, so it participates in
   * the structure diff, bumps `canvas.version`, and is undoable.
   *
   * Only meaningful for node types whose policy `kind` is `'toggleable'`
   * (today: `note`). Always-content and always-manual types ignore it.
   * Absent on nodes persisted before the field existed, where "auto" was
   * encoded as the *absence* of `style.height`; `resolveHeightMode`
   * owns that fallback.
   */
  heightMode?: HeightMode;
  /**
   * Cached measurement backing an auto height.
   *
   * Derived state, not content: it is a convergent cache that any client
   * can recompute, so it must not bump `canvas.version` or broadcast.
   * Its purpose is to give the node a correct footprint before it has
   * ever been rendered — on first paint, after virtualization remount,
   * and in the headless engine, which has no DOM to measure with.
   */
  autoHeight?: AutoHeightHint;
}

/** Who owns a node's height. See {@link BaseNodeData.heightMode}. */
export type HeightMode = 'auto' | 'fixed';

/**
 * A measurement of a node's content height, together with proof of what
 * it was measured against.
 *
 * Advisory, not authoritative. It does not promise that two clients
 * render the same height — font availability, browser version, and DPR
 * are deliberately outside the key — only that a client opening the
 * canvas starts from a plausible size instead of collapsing and then
 * jumping. Each client re-materializes locally and corrects if needed.
 */
export interface AutoHeightHint {
  /**
   * Content height in CSS pixels at the node type's reference width,
   * before any width scaling or chrome. The conversion to the number
   * written to `style.height` lives in `intrinsicToLayoutHeight`.
   */
  intrinsicHeight: number;
  /**
   * The `AutoHeightKey` this measurement is valid for — the rendering
   * pipeline version plus the node's content revision. Only a real
   * measurement may set it, so a hint can never claim to describe
   * content it was not measured against.
   */
  measuredFor: string;
  /**
   * The measurement was committed before the content had fully settled
   * (typically undecoded images). Treated as stale so the node is
   * re-measured, but kept because a provisional footprint beats none.
   */
  provisional?: boolean;
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
  /** Host-validated capability bridge definition for a local HTML artifact. */
  interactiveView?: InteractiveViewDefinitionV1;
  /** Optional Agent-defined discovery hint scoped to the owning Canvas. */
  viewKey?: string;
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

/**
 * Office document formats supported by the `office` node.
 * Backed server-side by `officeparser`; rendered as text-only previews
 * (the canvas card shows a format icon + AI summary; the expanded
 * preview shows the extracted markdown body).
 */
export const OFFICE_FORMATS = ['docx', 'pptx', 'xlsx'] as const;
export type OfficeFormat = (typeof OFFICE_FORMATS)[number];

/** Office node: Word / PowerPoint / Excel document (preview + ingest only). */
export interface OfficeNodeData extends BaseNodeData {
  type: 'office';
  src: string;
  /**
   * Concrete office format. Inferred from the uploaded file's extension
   * on the client and persisted so the renderer can pick the right icon
   * (Word / PowerPoint / Excel) without re-parsing `src`.
   */
  format: OfficeFormat;
  /** Optional manual cover image (mirrors `PdfNodeData.coverUrl`). */
  coverUrl?: string;
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

/** Audio node: audio content (typically recorded in-canvas) */
export interface AudioNodeData extends BaseNodeData {
  type: 'audio';
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
 * - `grid`   — N columns like `column`, but rows are aligned too: all
 *              children sharing a row band get one shared Y origin and
 *              the band's height is the tallest member. A column may
 *              legitimately have no member in a given band — that cell
 *              is simply left blank instead of being back-filled. This
 *              is what makes side-by-side correspondence survive a
 *              missing counterpart.
 *
 *              Row membership is persisted in {@link BaseNodeData.frameRow}
 *              so a drag moves one child rather than reshuffling every
 *              row against the rendered geometry. On the frame's FIRST
 *              pass through `grid` there is nothing to persist yet, so
 *              rows are seeded once from the children's current vertical
 *              overlap — globally, across columns, so whatever was
 *              side by side on screen stays side by side.
 */
export const FRAME_LAYOUT_MODES = ['free', 'column', 'row', 'grid'] as const;
export type FrameLayoutMode = (typeof FRAME_LAYOUT_MODES)[number];

/**
 * Frame size policy — orthogonal to {@link FrameLayoutMode}.
 *
 * - `hug`    — frame size is content-driven: it auto-fits to wrap its
 *              children (the "fit-to-children" behaviour). This is the
 *              default and matches the historical Auto-Layout-on flow.
 * - `manual` — frame size is user/agent-controlled: drag/resize sticks,
 *              and child additions / removals never reshape the frame.
 *
 * Note: in PR 1 only `'free' + manual` and `'free' + hug` and
 * `'column'/'row' + hug` are reachable through the UI. The combination
 * of a structured layout mode with `'manual'` sizing is reserved for a
 * future iteration that decouples the structured solver's children
 * pass from its frame-size pass.
 */
export const FRAME_SIZING_MODES = ['hug', 'manual'] as const;
export type FrameSizing = (typeof FRAME_SIZING_MODES)[number];

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
   * when `layoutMode === 'column'` or `'grid'`, as rows when
   * `layoutMode === 'row'`, ignored otherwise. Clamped to
   * [`FRAME_GRID_MIN_COUNT`, `FRAME_GRID_MAX_COUNT`].
   *
   * Absent means "not pinned": the solver derives the count from the
   * children's visual bands and writes the result back here. A layout
   * mode change clears the field for exactly that reason — a count
   * chosen for one axis says nothing about another, and reusing it
   * re-flows an arrangement the user did not ask to change.
   */
  gridCount?: number;
  /**
   * Minimum number of row bands for `grid` mode. Ignored by every other
   * layout.
   *
   * A floor rather than an exact count, because the two axes cannot be
   * pinned symmetrically: six children in three columns need two rows,
   * and asking for one cannot make them fit. Rows can only be added
   * (the surplus renders as blank, drop-target cells — blank cells are
   * meaningful in `grid`), never removed below what the content
   * requires.
   *
   * Absent means "no floor": the row count follows the content, which
   * is the default behaviour. Cleared on a layout-mode change for the
   * same reason {@link gridCount} is.
   */
  gridRowCount?: number;
  /**
   * Frame size policy. Defaults to `'hug'`. When `'manual'` the frame
   * is excluded from the engine's end-of-batch fit pass — its size is
   * persisted as-is and only changes when the user / agent explicitly
   * sets it via `SET_NODE_GEOMETRY`.
   */
  sizing?: FrameSizing;
}

/** A World-owned Portal that points to an ordinary Space Canvas. */
export interface CanvasRefNodeData extends BaseNodeData {
  type: 'canvasRef';
  targetCanvasId: string;
}

/** A view-only projection of another ordinary Space. */
export interface SpacePreviewNodeData extends BaseNodeData {
  type: 'spacePreview';
  targetCanvasId: string;
}

/** A World-owned symbolic reference to a node in an ordinary Space. */
export interface NodeRefNodeData extends BaseNodeData {
  type: 'nodeRef';
  origin?: never;
  label?: never;
  labelSource?: never;
  contentMissing?: never;
  artifactMissing?: never;
  contentDuplicate?: never;
  duplicateFiles?: never;
  frameColumn?: never;
  frameRow?: never;
  frameSlot?: never;
  target: {
    canvasId: string;
    nodeId: string;
  };
}

/** A World-owned symbolic Container reference to a source Frame. */
export interface FrameRefNodeData extends BaseNodeData {
  type: 'frameRef';
  origin?: never;
  label?: never;
  labelSource?: never;
  contentMissing?: never;
  artifactMissing?: never;
  contentDuplicate?: never;
  duplicateFiles?: never;
  frameColumn?: never;
  frameRow?: never;
  frameSlot?: never;
  target: {
    canvasId: string;
    nodeId: string;
  };
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
export type QuestionNodeStatus = 'idle' | 'running' | 'done' | 'error';

/** Whether an idle question thread may be rebound before its first turn. */
export type AgentBindingPolicy = 'selectable' | 'fixed';

/** Bounded per-thread overrides applied when an external Agent is realized. */
export interface AgentLaunchOverrides {
  workingDirPath?: string;
  additionalInitialPreamble?: string;
}

/** Resolve the sparse persisted question status; absent means idle. */
export function getQuestionNodeStatus(data: unknown): QuestionNodeStatus {
  const status =
    typeof data === 'object' && data !== null && 'status' in data
      ? (data as { status?: unknown }).status
      : undefined;
  return status === 'running' || status === 'done' || status === 'error'
    ? status
    : 'idle';
}

/** Question node: AI interaction medium embedded on canvas. */
export interface QuestionNodeData extends BaseNodeData {
  type: 'question';
  /**
   * The user's prompt. Persisted into the markdown sidecar body just
   * like text/note/web bodies (see `TEXT_BEARING_NODE_TYPES`) so a
   * single rule covers every searchable node type. Empty string when
   * the node has just been created and the user has not yet typed
   * anything.
   */
  content: string;
  /** Current execution status. Absent means `idle`. */
  status?: QuestionNodeStatus;
  /** Agent thread ID (set when the node is opened for composition). */
  threadId?: string;
  /** Error message when status === 'error'. */
  errorMessage?: string;
  /** Short AI response shown on node after completion. */
  responseSummary?: string;
  /** Whether the user has viewed the completed response in the chat panel. */
  viewed?: boolean;
  /**
   * Agent dispatch binding for this question, chosen via the inline
   * agent selector in the chat panel and written on the first send.
   * When omitted (default), the question runs against the built-in
   * agent with `agentMode='ask'`.
   */
  agentBinding?: AgentBinding;
  /**
   * Whether the binding may change before the first turn. Absent means
   * `selectable` for compatibility with user-created Question Nodes.
   */
  agentBindingPolicy?: AgentBindingPolicy;
  /**
   * Bind-time avatar fallback for this question's external agent. The UI
   * prefers the current Profile icon while that Profile exists, then uses this
   * snapshot if the Profile is deleted or unavailable. Internal agents use the
   * built-in Huabu identity instead.
   */
  agentIcon?: AgentIcon;
  /** External-Agent launch overrides fixed when this node is created. */
  agentLaunchOverrides?: AgentLaunchOverrides;
  /**
   * Built-in agent mode when `agentBinding` is internal or omitted.
   * Defaults to `'ask'`. Ignored for external bindings.
   */
  agentMode?: AgentMode;
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
  | OfficeNodeData
  | VideoNodeData
  | ImageNodeData
  | AudioNodeData
  | FrameNodeData
  | SpacePreviewNodeData
  | CanvasRefNodeData
  | FrameRefNodeData
  | NodeRefNodeData
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
): data is
  | WebNodeData
  | PdfNodeData
  | OfficeNodeData
  | VideoNodeData
  | ImageNodeData
  | AudioNodeData {
  return ['web', 'pdf', 'office', 'video', 'image', 'audio'].includes(
    data.type,
  );
}

export function isOfficeNode(data: NodeData): data is OfficeNodeData {
  return data.type === 'office';
}

export function isAudioNode(data: NodeData): data is AudioNodeData {
  return data.type === 'audio';
}

export function isFrameNode(data: NodeData): data is FrameNodeData {
  return data.type === 'frame';
}

export function isCanvasRefNode(data: NodeData): data is CanvasRefNodeData {
  return data.type === 'canvasRef';
}

export function isSpacePreviewNode(
  data: NodeData,
): data is SpacePreviewNodeData {
  return data.type === 'spacePreview';
}

export function isNodeRefNode(data: NodeData): data is NodeRefNodeData {
  return data.type === 'nodeRef';
}

export function isFrameRefNode(data: NodeData): data is FrameRefNodeData {
  return data.type === 'frameRef';
}

export function isSketchNode(data: NodeData): data is SketchNodeData {
  return data.type === 'sketch';
}

export function isQuestionNode(data: NodeData): data is QuestionNodeData {
  return data.type === 'question';
}
