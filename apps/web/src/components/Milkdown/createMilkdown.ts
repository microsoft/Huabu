/**
 * Internal Milkdown factory. NOT exported from the package barrel — only
 * `MilkdownEditor` and `MilkdownPreview` consume it.
 *
 * Why a thin handle and not the raw Crepe:
 *  - Keeps the surface area we depend on minimal (just five verbs).
 *  - Lets us swap Crepe for raw `@milkdown/kit` later without touching
 *    component code.
 *  - Hides the async lifecycle: callers always receive a ready instance.
 */

import {
  editorViewCtx,
  parserCtx,
  prosePluginsCtx,
  schemaCtx,
  serializerCtx,
} from '@milkdown/core';
import { Crepe } from '@milkdown/crepe';
import { blockConfig } from '@milkdown/plugin-block';
import { findParent } from '@milkdown/prose';
import { lift, setBlockType, wrapIn } from '@milkdown/prose/commands';
import { liftListItem, wrapInList } from '@milkdown/prose/schema-list';
import { NodeSelection, Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $prose, replaceAll } from '@milkdown/utils';

import { fingerprintBlocks, type BlockSnapshot } from '@/utils/blockProvenance';

import type { Ctx } from '@milkdown/ctx';
import type {
  Node as ProseNode,
  NodeType,
  ResolvedPos,
} from '@milkdown/prose/model';
import type { Command, EditorState, Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

import '@milkdown/crepe/theme/common/style.css';
import 'katex/dist/katex.min.css';
// Crepe's `theme/classic.css` is intentionally NOT imported. It only
// declares `--crepe-*` color / font / shadow tokens (warm-beige palette,
// Open Sans / Georgia / Fira Code, two shadows) and our overrides file
// declares every one of those tokens itself, so loading classic.css
// would just add a layer of values we immediately overwrite. Owning
// the palette outright means a future Crepe release that introduces a
// new `--crepe-*` token surfaces as a visible regression (rather than
// silently inheriting upstream defaults) — exactly the kind of
// notification we want.
//
// Loaded LAST so plain selectors win the cascade over Crepe's defaults
// without needing `!important`. Do not import this file anywhere else.
import './milkdown-overrides.css';

export interface MilkdownFactoryOptions {
  /** Element the editor view will be mounted into. */
  root: HTMLElement;
  /** Initial markdown payload. */
  initialMarkdown: string;
  /** Default `true`. */
  editable?: boolean;
  /** Optional placeholder text shown when the doc is empty. */
  placeholder?: string;
  /**
   * Drag-only preview mode (chat AI messages, etc.). Default `false`.
   *
   * Crepe's `setReadonly(true)` would be the natural choice, but it
   * also hides the block-drag handle (BlockProvider checks
   * `view.editable` before showing). So we instead keep the editor
   * editable and selectively disable the Crepe features that surface
   * edit affordances:
   *   - `Toolbar`     — the floating selection toolbar
   *   - `LinkTooltip` — link edit/remove popover
   *   - `Table`       — row / column reorder handles
   *   - `Cursor`      — drop indicator overlay + virtual caret; not
   *                     useful when input is suppressed, and avoids
   *                     leaking a hidden `<div>` per editor instance
   *
   * Input mutations are still suppressed at the React level by
   * `MilkdownPreview`'s capture handlers, so the editor behaves as
   * read-only while keeping the drag grip live.
   */
  previewMode?: boolean;
}

/** Range of a drag, expressed in ProseMirror doc positions. */
export interface MilkdownDragRange {
  from: number;
  to: number;
}

/** Drag payload resolved from a single block or a multi-block range. */
export interface MilkdownDragPayload {
  /** Markdown of the dragged content. */
  markdown: string;
  /**
   * Top-level block DOMs covered by the drag, in document order.
   * For single-block drags this contains exactly one element; for
   * multi-block drags it contains the visible DOM for each covered
   * block (callers use them to build a stacked drag preview).
   */
  blockElements: HTMLElement[];
}

/**
 * One-shot snapshot of every top-level block in document order.
 * `markdownByKey` / `domByKey` are lazy: the values are computed on
 * first read and cached for the lifetime of the snapshot. The snapshot
 * captures the doc state at the moment it was created — callers must
 * NOT hold on to it across mutations.
 */
export interface MilkdownBlockSnapshot {
  /** Fingerprint keys of every top-level block, in doc order. */
  readonly keys: string[];
  /** Lazily resolve the serialized markdown of the block at `key`. */
  getMarkdown(key: string): string | null;
  /** Lazily resolve the DOM element of the block at `key`. */
  getDOM(key: string): HTMLElement | null;
}

export interface MilkdownInstance {
  /** Read the current document as markdown. */
  getMarkdown(): string;
  /**
   * Replace the entire document. Uses Milkdown's `replaceAll` macro so
   * undo history is preserved.
   */
  setMarkdown(markdown: string): void;
  /** Toggle the editor between editable and read-only. */
  setReadonly(readonly: boolean): void;
  /**
   * Subscribe to markdown changes. Returns an unsubscribe function.
   * Listeners receive the raw editor output — components are expected to
   * apply `normalizeMarkdown` before propagating.
   */
  onMarkdownUpdated(listener: (markdown: string) => void): () => void;
  /**
   * If the current selection covers more than one top-level block,
   * returns the [from, to] range expanded to full block boundaries.
   * Returns `null` for empty selections, single-block selections, and
   * `NodeSelection`s.
   *
   * Used by `MilkdownPreview` to snapshot a multi-block text selection
   * BEFORE Crepe's block handle clobbers it with a single-block
   * `NodeSelection` on mousedown.
   */
  getMultiBlockSelectionRange(): MilkdownDragRange | null;
  /**
   * Resolve the drag payload (markdown + block DOMs).
   *
   * - When `range` is provided, serializes that explicit range as a
   *   multi-block drag.
   * - When `range` is null/undefined, serializes the current
   *   `NodeSelection` (set by Crepe's block handle on mousedown).
   *
   * Returns `null` when neither path produces content.
   */
  getDragPayload(range?: MilkdownDragRange | null): MilkdownDragPayload | null;

  // ---------- Phase 4 (block provenance) ----------

  /**
   * One-shot snapshot of every top-level block. Built with a single
   * doc traversal so callers that need multiple per-key lookups
   * (overlay coordinate sync, external-update diff) avoid the
   * O(N²) cost of calling `getBlockMarkdownByKey` / `getBlockDOMByKey`
   * in a loop.
   *
   * `markdownByKey` and `domByKey` are populated lazily (only when the
   * caller reads a key) so we don't pay for serializer / DOM lookups
   * we never need.
   */
  snapshotBlocks(): MilkdownBlockSnapshot;
  /**
   * Snapshot the current top-level blocks as fingerprint keys, in doc
   * order. Duplicate-content blocks receive `#N` suffixes (see
   * `fingerprintBlocks`).
   */
  getBlockKeys(): string[];
  /**
   * Markdown for one block, addressed by its fingerprint key.
   * Returns `null` when no block in the live doc carries that key.
   */
  getBlockMarkdownByKey(key: string): string | null;
  /**
   * The DOM element for one block, addressed by its fingerprint key.
   * Used by `TombstoneOverlay` to portal-mount under the surviving
   * neighbor without bypassing ProseMirror.
   */
  getBlockDOMByKey(key: string): HTMLElement | null;
  /**
   * Replace the block with `key` by parsing `markdown` and substituting
   * the resulting block content. Used by Reject to restore the AI'd
   * block back to its baseline. Returns `true` on success.
   */
  replaceBlockByKey(key: string, markdown: string): boolean;
  /**
   * Delete the block with `key` outright. Used by Reject when the
   * provenance entry is `kind: 'inserted'` (no baseline to restore).
   * Returns `true` on success.
   */
  deleteBlockByKey(key: string): boolean;
  /**
   * Insert one or more blocks parsed from `markdown` AFTER the block
   * identified by `anchorKey`. When `anchorKey` is `null`, inserts at
   * doc head. Used by Reject-deletion to restore a tombstoned block.
   * Returns `true` on success.
   */
  insertBlocksAfter(anchorKey: string | null, markdown: string): boolean;
  /**
   * Replace the active block-decoration set. Each entry highlights the
   * top-level block whose fingerprint key matches by adding `className`
   * via a `Decoration.node`. Pass `[]` to clear.
   */
  setBlockDecorations(
    specs: ReadonlyArray<{ key: string; className: string }>,
  ): void;

  /** Tear down the ProseMirror view and release resources. */
  destroy(): Promise<void>;
}

/**
 * Names of node types whose children we treat as individual drag
 * units. When the user has a text selection that lands inside one of
 * these (a `bullet_list`, `ordered_list`, etc.), the natural draggable
 * granularity is each child item — NOT the whole list. We use this in
 * two places:
 *
 *   1. `findDragBlockDepth` walks up from a `ResolvedPos` and stops as
 *      soon as the parent is `doc` OR one of these wrappers.
 *   2. `getDragPayload` descends into these wrappers when collecting
 *      `blockElements` so each list item contributes its own DOM to
 *      the stacked drag preview.
 *
 * Add new list-like wrappers here as the schema grows (e.g. a future
 * `task_list`).
 */
const LIST_NODE_NAMES = new Set(['bullet_list', 'ordered_list']);

/**
 * Find the depth at which the resolved position's "drag-block"
 * ancestor sits. The drag-block is the deepest ancestor whose PARENT
 * is the document root or a list wrapper (see `LIST_NODE_NAMES`).
 *
 * Examples (for `bullet_list > list_item > paragraph > text`):
 *  - `$pos` inside the paragraph → returns the list_item's depth.
 *  - `$pos` inside a top-level paragraph → returns the paragraph's depth.
 *  - `$pos` inside a paragraph in a blockquote → returns the blockquote's depth.
 *
 * Returns `null` when no suitable ancestor exists (e.g. when the
 * position is at depth 0 directly on the doc, which shouldn't happen
 * for a real user selection).
 */
function findDragBlockDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth >= 1; depth--) {
    const parentName = $pos.node(depth - 1).type.name;
    if (parentName === 'doc' || LIST_NODE_NAMES.has(parentName)) {
      return depth;
    }
  }
  return null;
}

/**
 * Run a ProseMirror `Command` against the current editor view and
 * restore focus afterwards. Used by the block-type toolbar buttons —
 * dispatching alone leaves focus on the toolbar's button, so the next
 * keystroke would be lost.
 */
function runCommand(ctx: Ctx, command: Command): void {
  const view = ctx.get(editorViewCtx);
  command(view.state, view.dispatch);
  view.focus();
}

/**
 * Resolve a node type by name from the current schema. Returns `null`
 * when the schema doesn't define it (e.g. a plugin was disabled), so
 * callers can render the button as a no-op rather than crashing.
 */
function getNodeType(ctx: Ctx, name: string): NodeType | null {
  const schema = ctx.get(schemaCtx);
  return schema.nodes[name] ?? null;
}

/**
 * Build the `buildToolbar` callback Crepe invokes after it has queued
 * its own `formatting` (bold / italic / strikethrough) and `function`
 * (code / latex / link) groups. We append a single dropdown trigger
 * whose icon mirrors the current block type and whose menu lets the
 * user "turn into" any of paragraph / H1-H3 / quote / bullet list /
 * ordered list / code block — Crepe's built-in toolbar only ships
 * inline-mark items, and the slash menu's `setBlockTypeCommand` chain
 * clears the block's text first, so neither surface exposes a
 * "turn this H1 into H2 (keeping the words)" path.
 *
 * Implementation notes:
 *  - The trigger renders ALL eight slash-menu SVGs side-by-side; CSS
 *    hides every icon except the one whose `data-key` matches the
 *    wrapper's `data-current` attribute. A ProseMirror plugin
 *    (`createBlockTypeIndicatorPlugin`) updates `data-current` after
 *    every selection change. We can't compute the icon dynamically
 *    inside `addItem` because Crepe memoises the toolbar group via
 *    `computed(getGroups)` and only re-evaluates `active`, not `icon`.
 *  - Clicking the trigger opens a body-mounted floating menu; we have
 *    to mount to body (not inside the toolbar) because the toolbar's
 *    floating-ui boundary clips overflow.
 *  - `setBlockType` is the heading/paragraph/code-block lever; it only
 *    swaps `nodeType` and preserves inline content. `wrapIn` and
 *    `wrapInList` cover the wrapper types.
 *  - When a node type is missing from the schema (e.g. a plugin was
 *    disabled) the corresponding entry is silently no-op'd.
 */

/**
 * Slash-menu SVG paths lifted from
 * `@milkdown/crepe/lib/esm/feature/block-edit/index.js` (lines 46-348).
 * Kept as raw `<path d=…>` strings rather than the original full
 * `<svg>…<defs><clipPath/></defs></svg>` because the clip-path is a
 * no-op (every path is already bounded by the 24x24 viewBox) and
 * stripping it sidesteps duplicate-id collisions when the same icon
 * appears in both the toolbar trigger and a menu item.
 */
const BLOCK_TYPE_ICON_PATHS = {
  paragraph:
    'M5 5.5C5 6.33 5.67 7 6.5 7H10.5V17.5C10.5 18.33 11.17 19 12 19C12.83 19 13.5 18.33 13.5 17.5V7H17.5C18.33 7 19 6.33 19 5.5C19 4.67 18.33 4 17.5 4H6.5C5.67 4 5 4.67 5 5.5Z',
  'heading-1':
    'M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM12 17H14V7H10V9H12V17Z',
  'heading-2':
    'M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM15 15H11V13H13C14.1 13 15 12.11 15 11V9C15 7.89 14.1 7 13 7H9V9H13V11H11C9.9 11 9 11.89 9 13V17H15V15Z',
  'heading-3':
    'M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM15 15V13.5C15 12.67 14.33 12 13.5 12C14.33 12 15 11.33 15 10.5V9C15 7.89 14.1 7 13 7H9V9H13V11H11V13H13V15H9V17H13C14.1 17 15 16.11 15 15Z',
  blockquote:
    'M7.17 17C7.68 17 8.15 16.71 8.37 16.26L9.79 13.42C9.93 13.14 10 12.84 10 12.53V8C10 7.45 9.55 7 9 7H5C4.45 7 4 7.45 4 8V12C4 12.55 4.45 13 5 13H7L5.97 15.06C5.52 15.95 6.17 17 7.17 17ZM17.17 17C17.68 17 18.15 16.71 18.37 16.26L19.79 13.42C19.93 13.14 20 12.84 20 12.53V8C20 7.45 19.55 7 19 7H15C14.45 7 14 7.45 14 8V12C14 12.55 14.45 13 15 13H17L15.97 15.06C15.52 15.95 16.17 17 17.17 17Z',
  'bullet-list':
    'M4 10.5C3.17 10.5 2.5 11.17 2.5 12C2.5 12.83 3.17 13.5 4 13.5C4.83 13.5 5.5 12.83 5.5 12C5.5 11.17 4.83 10.5 4 10.5ZM4 4.5C3.17 4.5 2.5 5.17 2.5 6C2.5 6.83 3.17 7.5 4 7.5C4.83 7.5 5.5 6.83 5.5 6C5.5 5.17 4.83 4.5 4 4.5ZM4 16.5C3.17 16.5 2.5 17.18 2.5 18C2.5 18.82 3.18 19.5 4 19.5C4.82 19.5 5.5 18.82 5.5 18C5.5 17.18 4.83 16.5 4 16.5ZM8 19H20C20.55 19 21 18.55 21 18C21 17.45 20.55 17 20 17H8C7.45 17 7 17.45 7 18C7 18.55 7.45 19 8 19ZM8 13H20C20.55 13 21 12.55 21 12C21 11.45 20.55 11 20 11H8C7.45 11 7 11.45 7 12C7 12.55 7.45 13 8 13ZM7 6C7 6.55 7.45 7 8 7H20C20.55 7 21 6.55 21 6C21 5.45 20.55 5 20 5H8C7.45 5 7 5.45 7 6Z',
  'ordered-list':
    'M8 7H20C20.55 7 21 6.55 21 6C21 5.45 20.55 5 20 5H8C7.45 5 7 5.45 7 6C7 6.55 7.45 7 8 7ZM20 17H8C7.45 17 7 17.45 7 18C7 18.55 7.45 19 8 19H20C20.55 19 21 18.55 21 18C21 17.45 20.55 17 20 17ZM20 11H8C7.45 11 7 11.45 7 12C7 12.55 7.45 13 8 13H20C20.55 13 21 12.55 21 12C21 11.45 20.55 11 20 11ZM4.5 16H2.5C2.22 16 2 16.22 2 16.5C2 16.78 2.22 17 2.5 17H4V17.5H3.5C3.22 17.5 3 17.72 3 18C3 18.28 3.22 18.5 3.5 18.5H4V19H2.5C2.22 19 2 19.22 2 19.5C2 19.78 2.22 20 2.5 20H4.5C4.78 20 5 19.78 5 19.5V16.5C5 16.22 4.78 16 4.5 16ZM2.5 5H3V7.5C3 7.78 3.22 8 3.5 8C3.78 8 4 7.78 4 7.5V4.5C4 4.22 3.78 4 3.5 4H2.5C2.22 4 2 4.22 2 4.5C2 4.78 2.22 5 2.5 5ZM4.5 10H2.5C2.22 10 2 10.22 2 10.5C2 10.78 2.22 11 2.5 11H3.8L2.12 12.96C2.04 13.05 2 13.17 2 13.28V13.5C2 13.78 2.22 14 2.5 14H4.5C4.78 14 5 13.78 5 13.5C5 13.22 4.78 13 4.5 13H3.2L4.88 11.04C4.96 10.95 5 10.83 5 10.72V10.5C5 10.22 4.78 10 4.5 10Z',
  'code-block':
    'M9.4 16.6L4.8 12L9.4 7.4L8 6L2 12L8 18L9.4 16.6ZM14.6 16.6L19.2 12L14.6 7.4L16 6L22 12L16 18L14.6 16.6Z',
} as const;

type BlockTypeKey = keyof typeof BLOCK_TYPE_ICON_PATHS;

const BLOCK_TYPE_KEYS: readonly BlockTypeKey[] = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'blockquote',
  'bullet-list',
  'ordered-list',
  'code-block',
];

/** Label rendered in the dropdown menu (icon-only on the trigger). */
const BLOCK_TYPE_LABELS: Record<BlockTypeKey, string> = {
  paragraph: 'Paragraph',
  'heading-1': 'Heading 1',
  'heading-2': 'Heading 2',
  'heading-3': 'Heading 3',
  blockquote: 'Quote',
  'bullet-list': 'Bullet list',
  'ordered-list': 'Numbered list',
  'code-block': 'Code block',
};

/** Minimal `<svg>` wrapper around a single path; sized via the parent. */
function blockTypeIconSvg(key: BlockTypeKey): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="${BLOCK_TYPE_ICON_PATHS[key]}"/></svg>`;
}

/**
 * Resolve which `BlockTypeKey` describes the block under the current
 * selection's `$from`. Headings outside the H1-H3 range fall back to
 * `null` (we render the trigger using "paragraph" as a sensible
 * default — `paragraph` is the closest neutral icon and the dropdown
 * still shows the right active item once opened).
 */
function resolveBlockTypeKey(state: EditorState): BlockTypeKey | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    const name = node.type.name;
    if (name === 'heading') {
      const level = node.attrs.level;
      if (level === 1) return 'heading-1';
      if (level === 2) return 'heading-2';
      if (level === 3) return 'heading-3';
      return null;
    }
    if (name === 'code_block') return 'code-block';
  }
  // Wrappers second — a paragraph nested in a list should still surface
  // the list (more "useful" type) for the trigger, but a plain
  // top-level paragraph shows paragraph.
  for (let depth = $from.depth; depth >= 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === 'blockquote') return 'blockquote';
    if (name === 'bullet_list') return 'bullet-list';
    if (name === 'ordered_list') return 'ordered-list';
  }
  return 'paragraph';
}

/** Schema node-name used to invoke the underlying PM command for a key. */
const BLOCK_TYPE_NODE_NAME: Record<BlockTypeKey, string> = {
  paragraph: 'paragraph',
  'heading-1': 'heading',
  'heading-2': 'heading',
  'heading-3': 'heading',
  blockquote: 'blockquote',
  'bullet-list': 'bullet_list',
  'ordered-list': 'ordered_list',
  'code-block': 'code_block',
};

/** Run the PM "turn into" command for a given block-type key. */
function runBlockTypeCommand(ctx: Ctx, key: BlockTypeKey): void {
  const view = ctx.get(editorViewCtx);

  // Lift the cursor out of every `blockquote` / `list_item` wrapper
  // before applying the target type. Without this step, switching FROM
  // a blockquote (or list item) to anything is a visual no-op: the
  // textblock under the cursor changes type but stays wrapped, so the
  // user still sees the quote rail or list bullet. ProseMirror's
  // `setBlockType` / `wrapIn` only operate on the immediate textblock
  // and its parent; the wrappers above are untouched. We loop because
  // a single click may need to peel off multiple layers (e.g. nested
  // list, or a quote-inside-list).
  const schema = view.state.schema;
  const listItemType = schema.nodes.list_item;
  for (let i = 0; i < 10; i++) {
    const { $from } = view.state.selection;
    let wrapped = false;
    for (let depth = $from.depth; depth >= 0; depth--) {
      const name = $from.node(depth).type.name;
      if (name === 'blockquote' || name === 'list_item') {
        wrapped = true;
        break;
      }
    }
    if (!wrapped) break;
    let didLift = false;
    if (listItemType) {
      didLift = liftListItem(listItemType)(view.state, view.dispatch);
    }
    if (!didLift) {
      didLift = lift(view.state, view.dispatch);
    }
    if (!didLift) break;
  }

  const name = BLOCK_TYPE_NODE_NAME[key];
  const type = getNodeType(ctx, name);
  if (!type) return;
  if (key === 'paragraph') {
    runCommand(ctx, setBlockType(type));
  } else if (key === 'heading-1') {
    runCommand(ctx, setBlockType(type, { level: 1 }));
  } else if (key === 'heading-2') {
    runCommand(ctx, setBlockType(type, { level: 2 }));
  } else if (key === 'heading-3') {
    runCommand(ctx, setBlockType(type, { level: 3 }));
  } else if (key === 'code-block') {
    runCommand(ctx, setBlockType(type));
  } else if (key === 'blockquote') {
    runCommand(ctx, wrapIn(type));
  } else if (key === 'bullet-list' || key === 'ordered-list') {
    runCommand(ctx, wrapInList(type));
  }
}

/**
 * ProseMirror plugin that keeps every visible
 * `.mb-block-type-trigger`'s `data-current` attribute synced with the
 * current selection's block type. Plugin (rather than per-item
 * `active` callback) because Crepe memoises the toolbar group's
 * `icon` field and only re-evaluates `active` — we need to drive
 * the icon through CSS, hence DOM-attribute mutation.
 *
 * Runs on every `view.update`; cheap (one selector + attribute write).
 */
function createBlockTypeIndicatorPlugin(): Plugin {
  return new Plugin({
    view: () => ({
      update(view) {
        const key = resolveBlockTypeKey(view.state) ?? 'paragraph';
        const triggers = document.querySelectorAll<HTMLElement>(
          '.mb-block-type-trigger',
        );
        triggers.forEach((el) => {
          if (el.dataset.current !== key) el.dataset.current = key;
        });
      },
    }),
  });
}

// ---------- Block-type dropdown menu (singleton, body-mounted) ----------

interface BlockTypeMenuState {
  ctx: Ctx;
  root: HTMLElement;
  cleanup: () => void;
}

let activeBlockTypeMenu: BlockTypeMenuState | null = null;

function closeBlockTypeMenu(): void {
  if (!activeBlockTypeMenu) return;
  const { root, cleanup } = activeBlockTypeMenu;
  activeBlockTypeMenu = null;
  cleanup();
  root.remove();
}

function findVisibleTrigger(): HTMLElement | null {
  const triggers = document.querySelectorAll<HTMLElement>(
    '.mb-block-type-trigger',
  );
  for (const el of triggers) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return el;
  }
  return null;
}

function openBlockTypeMenu(ctx: Ctx, triggerEl: HTMLElement): void {
  closeBlockTypeMenu();

  const view = ctx.get(editorViewCtx);
  const activeKey = resolveBlockTypeKey(view.state);

  const root = document.createElement('div');
  root.className = 'mb-block-type-menu';
  root.setAttribute('role', 'menu');
  root.innerHTML = BLOCK_TYPE_KEYS.map(
    (key) =>
      `<button type="button" role="menuitem" class="mb-block-type-menu__item${key === activeKey ? ' is-active' : ''}" data-key="${key}">` +
      `<span class="mb-block-type-menu__icon">${blockTypeIconSvg(key)}</span>` +
      `<span class="mb-block-type-menu__label">${BLOCK_TYPE_LABELS[key]}</span>` +
      `</button>`,
  ).join('');

  // Position below the trigger, right-aligned to its right edge so the
  // menu doesn't overflow when the toolbar is near the viewport edge.
  // We use `position: fixed` because the toolbar is itself
  // floating-ui-positioned and its containing block clips overflow.
  const triggerRect = triggerEl.getBoundingClientRect();
  document.body.appendChild(root);
  const menuRect = root.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(
      window.innerWidth - menuRect.width - 8,
      triggerRect.left + triggerRect.width / 2 - menuRect.width / 2,
    ),
  );
  const top = Math.min(
    window.innerHeight - menuRect.height - 8,
    triggerRect.bottom + 6,
  );
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;

  // Mousedown on a menu item: prevent the default focus shuffle (which
  // would collapse the editor selection before our command runs), then
  // dispatch the turn-into command and close.
  const onMousedown = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>('.mb-block-type-menu__item');
    if (!item || !root.contains(item)) return;
    event.preventDefault();
    event.stopPropagation();
    const key = item.dataset.key as BlockTypeKey | undefined;
    if (!key) return;
    runBlockTypeCommand(ctx, key);
    closeBlockTypeMenu();
  };
  root.addEventListener('mousedown', onMousedown);

  // Outside-click → close. `mousedown` (not `click`) so we close before
  // the toolbar's own click handlers run, matching popover convention.
  const onDocPointerDown = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (target && root.contains(target)) return;
    if (target && triggerEl.contains(target)) return;
    closeBlockTypeMenu();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeBlockTypeMenu();
      view.focus();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  // Toolbar can be repositioned on scroll/resize; just close.
  const onScrollOrResize = () => closeBlockTypeMenu();
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize, true);

  const cleanup = () => {
    root.removeEventListener('mousedown', onMousedown);
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
  };

  activeBlockTypeMenu = { ctx, root, cleanup };
}

function configureBlockTypeToolbar(builder: {
  addGroup: (
    key: string,
    label: string,
  ) => {
    addItem: (
      key: string,
      item: {
        active: (ctx: Ctx) => boolean;
        icon: string;
        onRun?: (ctx: Ctx) => void;
      },
    ) => unknown;
  };
}): void {
  const group = builder.addGroup('block-type', 'Block type');

  // Trigger icon: render ALL eight SVGs side-by-side; CSS shows only
  // the one matching `data-current`. Default to "paragraph" so the
  // first paint (before any selection update fires) isn't blank.
  const triggerInner = BLOCK_TYPE_KEYS.map(
    (key) =>
      `<span class="mb-block-type-trigger__icon" data-key="${key}">${blockTypeIconSvg(key)}</span>`,
  ).join('');
  const triggerHtml =
    `<span class="mb-block-type-trigger" data-current="paragraph">` +
    triggerInner +
    `</span>`;

  group.addItem('block-type-trigger', {
    icon: triggerHtml,
    // We mark the trigger active iff a menu is open for it; otherwise
    // the toolbar's own "highlight current group" logic would never
    // light up because we don't have a per-key active state on this
    // single item. Keeping it `false` is fine — the dynamic icon is
    // already a stronger indicator than a background highlight.
    active: () => false,
    onRun: (ctx) => {
      // If the menu is already open, toggle closed (Notion behavior).
      if (activeBlockTypeMenu) {
        closeBlockTypeMenu();
        return;
      }
      const triggerEl = findVisibleTrigger();
      if (!triggerEl) return;
      openBlockTypeMenu(ctx, triggerEl);
    },
  });
}

/**
 * Build and start a Crepe-backed editor.
 *
 * The feature set is hand-picked to match what we ship in Sediment:
 *  - `ImageBlock` is disabled because it pulls Vue into the bundle.
 *  - `AI` and `TopBar` are disabled because we render our own chrome.
 *  - When `previewMode` is set, `Toolbar` / `LinkTooltip` / `Table` /
 *    `Cursor` are additionally disabled — see
 *    `MilkdownFactoryOptions.previewMode`.
 *
 * Everything else (block-edit drag handle, list-item, latex,
 * placeholder, code-mirror) is on. `cursor` (drop-indicator + virtual
 * caret) is on for editable instances only.
 */
export async function createMilkdown(
  options: MilkdownFactoryOptions,
): Promise<MilkdownInstance> {
  const {
    root,
    initialMarkdown,
    editable = true,
    placeholder,
    previewMode = false,
  } = options;

  const crepe = new Crepe({
    root,
    defaultValue: initialMarkdown,
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
      // Hide all edit-time popovers in preview mode. BlockEdit stays
      // on so the drag handle is still rendered; the slash menu inside
      // BlockEdit is naturally suppressed because input events never
      // reach the editor (see `MilkdownPreview` capture handlers).
      //
      // `Cursor` is also disabled in preview mode: it injects a
      // permanent `<div class="crepe-drop-cursor milkdown-drop-indicator">`
      // sibling next to every editor root to render the drop bar, plus
      // a virtual caret plugin. Preview surfaces never accept drops and
      // never receive typing input, so both are dead weight — and with
      // N message cards in a long thread we'd otherwise leak N hidden
      // overlay divs into the DOM.
      ...(previewMode
        ? {
            [Crepe.Feature.Toolbar]: false,
            [Crepe.Feature.LinkTooltip]: false,
            [Crepe.Feature.Table]: false,
            [Crepe.Feature.Cursor]: false,
          }
        : {}),
    },
    featureConfigs: {
      ...(placeholder
        ? { [Crepe.Feature.Placeholder]: { text: placeholder } }
        : {}),
      // Append a "Block type" group (paragraph / H1-H3 / quote / lists /
      // code) after Crepe's own `formatting` and `function` groups —
      // see `configureBlockTypeToolbar` for the rationale.
      [Crepe.Feature.Toolbar]: { buildToolbar: configureBlockTypeToolbar },
    },
  });

  // Register the markdown listener BEFORE `create()`. Crepe's `on()` runs
  // the callback during editor construction, so subscribers must be queued
  // up front.
  const listeners = new Set<(markdown: string) => void>();
  crepe.on((api) => {
    api.markdownUpdated((_ctx, markdown) => {
      for (const listener of listeners) listener(markdown);
    });
  });

  // Patch the block-handle `filterNodes` AFTER Crepe queues its own
  // BlockEdit config (so this `ctx.set` wins). Crepe's default filter
  // only returns `false` when the resolved position has a `table`,
  // `blockquote`, or `math_inline` ANCESTOR — but `math_inline` is an
  // `atom: true, inline: true` node, so the cursor can never be INSIDE
  // it; `findParent` therefore never catches it. The upstream
  // `selectRootNodeByDom` walk-up only triggers when (a) filterNodes
  // returns false, or (b) the position is at index 0 of its parent.
  // Result: hovering anywhere mid-line over a paragraph containing
  // inline math makes the handle latch onto the math span itself, so
  // the drag/+ buttons visually float over the formula.
  //
  // Fix: also reject any candidate `node` that is `isInline` (or whose
  // ancestor is one of the original block-level filter targets). That
  // forces the walk-up to continue until a real block-level ancestor
  // (paragraph, heading, list_item, …) is reached.
  crepe.editor.config((ctx) => {
    ctx.set(blockConfig.key, {
      filterNodes: (pos, node) => {
        if (node.isInline) return false;
        const blockedAncestor = findParent((ancestor) =>
          ['table', 'blockquote'].includes(ancestor.type.name),
        )(pos);
        if (blockedAncestor) return false;
        return true;
      },
    });
  });

  // Register the block-type indicator plugin via `prosePluginsCtx`.
  // It mutates `data-current` on every `.mb-block-type-trigger` after
  // every selection change, so the toolbar's dropdown trigger always
  // reflects the block under the cursor. See
  // `createBlockTypeIndicatorPlugin` for why we drive this via a PM
  // plugin rather than the toolbar item's own `active` callback.
  crepe.editor.config((ctx) => {
    ctx.update(prosePluginsCtx, (plugins) => [
      ...plugins,
      createBlockTypeIndicatorPlugin(),
    ]);
  });

  // Phase 4: provenance decoration plugin.
  // We expose a single `setBlockDecorations` verb that dispatches a
  // meta-bearing transaction; the plugin recomputes its DecorationSet
  // from the doc + spec list. Block-keys (fingerprints) are computed
  // here against the LIVE doc so the spec stays trivially serializable
  // (just `{key, className}`).
  const decorationPluginKey = new PluginKey<{
    specs: ReadonlyArray<{ key: string; className: string }>;
    set: DecorationSet;
  }>('sediment-block-provenance');
  const META_KEY = 'sediment/setBlockDecorations';

  function buildDecorationSet(
    doc: ProseNode,
    specs: ReadonlyArray<{ key: string; className: string }>,
  ): DecorationSet {
    if (specs.length === 0) return DecorationSet.empty;
    const snaps: BlockSnapshot[] = [];
    doc.forEach((node) => {
      snaps.push(node.toJSON() as BlockSnapshot);
    });
    const keys = fingerprintBlocks(snaps);
    const byKey = new Map(specs.map((s) => [s.key, s.className]));
    const decorations: Decoration[] = [];
    let pos = 0;
    for (let i = 0; i < doc.childCount; i++) {
      const child = doc.child(i);
      const className = byKey.get(keys[i]);
      if (className) {
        decorations.push(
          Decoration.node(pos, pos + child.nodeSize, { class: className }),
        );
      }
      pos += child.nodeSize;
    }
    return DecorationSet.create(doc, decorations);
  }

  interface DecorationPluginState {
    specs: ReadonlyArray<{ key: string; className: string }>;
    set: DecorationSet;
  }

  crepe.editor.use(
    $prose(
      () =>
        new Plugin<DecorationPluginState>({
          key: decorationPluginKey,
          state: {
            init: (): DecorationPluginState => ({
              specs: [],
              set: DecorationSet.empty,
            }),
            apply: (
              tr: Transaction,
              value: DecorationPluginState,
            ): DecorationPluginState => {
              const meta = tr.getMeta(META_KEY) as
                | ReadonlyArray<{ key: string; className: string }>
                | undefined;
              if (meta !== undefined) {
                return { specs: meta, set: buildDecorationSet(tr.doc, meta) };
              }
              if (tr.docChanged) {
                return {
                  specs: value.specs,
                  set: buildDecorationSet(tr.doc, value.specs),
                };
              }
              return {
                specs: value.specs,
                set: value.set.map(tr.mapping, tr.doc),
              };
            },
          },
          props: {
            decorations(state: EditorState) {
              return decorationPluginKey.getState(state)?.set;
            },
          },
        }),
    ),
  );

  await crepe.create();
  crepe.setReadonly(!editable);

  return {
    getMarkdown: () => crepe.getMarkdown(),
    setMarkdown: (markdown: string) => {
      crepe.editor.action(replaceAll(markdown));
    },
    setReadonly: (readonly: boolean) => {
      crepe.setReadonly(readonly);
    },
    onMarkdownUpdated: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getMultiBlockSelectionRange: () => {
      let result: MilkdownDragRange | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const { selection } = state;
        // A NodeSelection means Crepe's handle has already snapped to
        // a single block — that path is handled by `getDragPayload`.
        if (selection instanceof NodeSelection) return;
        if (selection.empty) return;

        const fromDepth = findDragBlockDepth(selection.$from);
        const toDepth = findDragBlockDepth(selection.$to);
        if (fromDepth === null || toDepth === null) return;

        const fromBlockStart = selection.$from.before(fromDepth);
        const fromBlockEnd = selection.$from.after(fromDepth);
        const toBlockStart = selection.$to.before(toDepth);
        const toBlockEnd = selection.$to.after(toDepth);

        // Both endpoints inside the same drag-block (e.g. cursor or
        // single-paragraph highlight, or two carets in the same list
        // item) → not a multi-block selection. Let the single-block
        // fallback handle it.
        if (fromBlockStart === toBlockStart && fromBlockEnd === toBlockEnd)
          return;
        if (toBlockStart >= fromBlockStart && toBlockEnd <= fromBlockEnd)
          return;

        // `$from` is always before `$to` in a PM selection, so the
        // earliest start and latest end form the union range.
        result = { from: fromBlockStart, to: toBlockEnd };
      });
      return result;
    },
    getDragPayload: (range) => {
      let result: MilkdownDragPayload | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const serializer = ctx.get(serializerCtx);

        if (range) {
          // Multi-block path. The slice may have open boundaries when
          // the range starts/ends inside a list wrapper (e.g. when the
          // user selected 2 of 3 list items — the slice content is
          // then a `bullet_list` with `openStart`/`openEnd` of 1, and
          // contains exactly the selected items). Wrapping the slice
          // `content` in a fresh doc node yields well-formed markdown
          // for both flat blocks and nested list items.
          const slice = view.state.doc.slice(range.from, range.to);
          if (slice.content.size === 0) return;
          const docNode = view.state.schema.topNodeType.create(
            null,
            slice.content,
          );
          const markdown = serializer(docNode);
          if (!markdown.trim()) return;

          // Collect the user-visible DOM for each drag-block inside
          // the range. We can't just iterate `slice.content` because
          // when `openStart`/`openEnd` > 0, its top-level children are
          // wrapper nodes (e.g. the whole `bullet_list`) rather than
          // the individual `list_item`s. Instead we walk the live doc
          // between `range.from` and `range.to` and pick the nearest
          // drag-block-granularity nodes.
          const blockElements: HTMLElement[] = [];
          view.state.doc.nodesBetween(
            range.from,
            range.to,
            (node, pos, parent) => {
              const nodeName = node.type.name;
              const parentName = parent?.type.name;
              // Descend into list wrappers so we visit individual
              // `list_item`s rather than dragging the whole list.
              if (LIST_NODE_NAMES.has(nodeName)) return true;
              // A drag-block is either a direct child of the doc or
              // an item directly inside a list wrapper.
              if (
                parentName === 'doc' ||
                (parentName && LIST_NODE_NAMES.has(parentName))
              ) {
                const dom = view.nodeDOM(pos);
                if (dom instanceof HTMLElement) blockElements.push(dom);
                return false;
              }
              return true;
            },
          );

          result = { markdown, blockElements };
          return;
        }

        // Single-block path: rely on the `NodeSelection` that Crepe's
        // block handle dispatched on mousedown.
        const selection = view.state.selection;
        if (!(selection instanceof NodeSelection)) return;

        const node = selection.node;
        const docNode = view.state.schema.topNodeType.create(null, node);
        const markdown = serializer(docNode);
        if (!markdown.trim()) return;

        const domAtPos = view.nodeDOM(selection.from);
        const element =
          domAtPos instanceof HTMLElement
            ? domAtPos
            : (view.dom as HTMLElement);

        result = { markdown, blockElements: [element] };
      });
      return result;
    },

    // ---------- Phase 4 helpers ----------

    // All Phase 4 lookups share a single snapshot builder so callers
    // that need many per-key reads (overlay coordinate sync,
    // applyExternal stamping) pay O(N) instead of O(N²) for the
    // fingerprint pass.
    snapshotBlocks: () => buildBlockSnapshot(),

    getBlockKeys: () => buildBlockSnapshot().keys,

    getBlockMarkdownByKey: (key: string) =>
      buildBlockSnapshot().getMarkdown(key),

    getBlockDOMByKey: (key: string) => buildBlockSnapshot().getDOM(key),

    replaceBlockByKey: (key, markdown) => {
      let ok = false;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const snap = buildSnapshotFromView(view);
        const idx = snap.keys.indexOf(key);
        if (idx === -1) return;
        const from = snap.posByIndex[idx];
        const to = from + view.state.doc.child(idx).nodeSize;
        const parsed = parser(markdown);
        if (!parsed) return;
        // The parser returns a doc node; its content is the parsed blocks.
        const tr = view.state.tr.replaceWith(from, to, parsed.content);
        view.dispatch(tr);
        ok = true;
      });
      return ok;
    },

    deleteBlockByKey: (key) => {
      let ok = false;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const snap = buildSnapshotFromView(view);
        const idx = snap.keys.indexOf(key);
        if (idx === -1) return;
        const from = snap.posByIndex[idx];
        const to = from + view.state.doc.child(idx).nodeSize;
        const tr = view.state.tr.delete(from, to);
        view.dispatch(tr);
        ok = true;
      });
      return ok;
    },

    insertBlocksAfter: (anchorKey, markdown) => {
      let ok = false;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const parsed = parser(markdown);
        if (!parsed) return;

        let pos = 0;
        if (anchorKey !== null) {
          const snap = buildSnapshotFromView(view);
          const idx = snap.keys.indexOf(anchorKey);
          if (idx === -1) return;
          // pos = end of block `idx` = start of block `idx+1`.
          pos = snap.posByIndex[idx] + view.state.doc.child(idx).nodeSize;
        }
        const tr = view.state.tr.insert(pos, parsed.content);
        view.dispatch(tr);
        ok = true;
      });
      return ok;
    },

    setBlockDecorations: (specs) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setMeta(META_KEY, specs));
      });
    },

    destroy: async () => {
      listeners.clear();
      await crepe.destroy();
    },
  };

  /**
   * Internal: walk every top-level block once and produce both the
   * fingerprint keys and a position index. Used by every Phase 4
   * helper. Returns the structural data without serializer/DOM —
   * those are layered on by `buildBlockSnapshot` for public callers.
   */
  function buildSnapshotFromView(view: EditorView): {
    keys: string[];
    posByIndex: number[];
  } {
    const snaps: BlockSnapshot[] = [];
    const posByIndex: number[] = [];
    let pos = 0;
    view.state.doc.forEach((node) => {
      posByIndex.push(pos);
      snaps.push(node.toJSON() as BlockSnapshot);
      pos += node.nodeSize;
    });
    return { keys: fingerprintBlocks(snaps), posByIndex };
  }

  /**
   * Build a public snapshot with lazy markdown / DOM resolution.
   * Each per-key value is computed at most once per snapshot.
   */
  function buildBlockSnapshot(): MilkdownBlockSnapshot {
    let keys: string[] = [];
    let posByIndex: number[] = [];
    let view: EditorView | null = null;
    let serializer: ((node: ProseNode) => string) | null = null;

    crepe.editor.action((ctx) => {
      view = ctx.get(editorViewCtx);
      serializer = ctx.get(serializerCtx);
      const snap = buildSnapshotFromView(view);
      keys = snap.keys;
      posByIndex = snap.posByIndex;
    });

    const indexByKey = new Map<string, number>();
    keys.forEach((k, i) => indexByKey.set(k, i));

    const markdownCache = new Map<string, string | null>();
    const domCache = new Map<string, HTMLElement | null>();

    return {
      keys,
      getMarkdown(key: string): string | null {
        if (markdownCache.has(key)) return markdownCache.get(key) ?? null;
        const idx = indexByKey.get(key);
        if (idx === undefined || !view || !serializer) {
          markdownCache.set(key, null);
          return null;
        }
        const v: EditorView = view;
        const target = v.state.doc.child(idx);
        const docNode = v.state.schema.topNodeType.create(null, target);
        const md = serializer(docNode);
        markdownCache.set(key, md);
        return md;
      },
      getDOM(key: string): HTMLElement | null {
        if (domCache.has(key)) return domCache.get(key) ?? null;
        const idx = indexByKey.get(key);
        if (idx === undefined || !view) {
          domCache.set(key, null);
          return null;
        }
        const v: EditorView = view;
        const node = v.nodeDOM(posByIndex[idx]);
        const dom = node instanceof HTMLElement ? node : null;
        domCache.set(key, dom);
        return dom;
      },
    };
  }
}
