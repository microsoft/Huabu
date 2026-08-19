// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  editorViewOptionsCtx,
  parserCtx,
  schemaCtx,
  serializerCtx,
} from '@milkdown/core';
import { Crepe } from '@milkdown/crepe';
import { blockConfig } from '@milkdown/plugin-block';
import { dropIndicatorState } from '@milkdown/plugin-cursor';
import { findParent } from '@milkdown/prose';
import {
  lift,
  setBlockType,
  toggleMark,
  wrapIn,
} from '@milkdown/prose/commands';
import { keymap } from '@milkdown/prose/keymap';
import { Slice } from '@milkdown/prose/model';
import {
  liftListItem,
  sinkListItem,
  wrapInList,
} from '@milkdown/prose/schema-list';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
} from '@milkdown/prose/state';
import { canJoin } from '@milkdown/prose/transform';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { $markSchema, $prose, $remark, replaceAll } from '@milkdown/utils';

import { isAccentToken, resolveAccent, type AccentToken } from '@huabu/shared';
import { fingerprintMarkdownKeys } from '@huabu/shared/canvas-engine';

import { toast } from '@/components/Common/Toast';
import { getAccentTokens } from '@/components/Nodes/accentTokens';
import { fingerprintBlocks, type BlockSnapshot } from '@/utils/blockProvenance';
import {
  parseHuabuImageClipboard,
  readHuabuClipboardPayload,
} from '@/utils/io/clipboard';
import { isMac } from '@/utils/platform';

import { normalizeMathDelimiters } from './markdownUtils';

import type {
  MilkdownBackgroundColor,
  MilkdownBlockType,
  MilkdownFormattingState,
  MilkdownInlineMark,
  MilkdownTextColor,
} from './types';
import type { Ctx } from '@milkdown/ctx';
import type {
  Fragment,
  Mark,
  MarkType,
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

/**
 * Compute the block-provenance keys for a live ProseMirror doc.
 *
 * Keys are derived from the shared mdast fingerprint of the serialized
 * markdown so they match the keys the server stamps onto
 * `data.provenance`. The mdast segmentation aligns 1:1 with the
 * ProseMirror top-level blocks for all supported note content (guarded
 * by the block-key parity test); the returned array is therefore
 * index-aligned with `doc.child(i)`.
 *
 * If a rare doc segments differently (mdast block count != PM child
 * count), we fall back to the legacy per-block ProseMirror fingerprint
 * so the editor's own block mechanics (drag / replace / delete) never
 * break — provenance decorations simply won't attach for that doc.
 */
function blockKeysForDoc(
  doc: ProseNode,
  serialize: (node: ProseNode) => string,
): string[] {
  const mdastKeys = fingerprintMarkdownKeys(serialize(doc));
  if (mdastKeys.length === doc.childCount) return mdastKeys;
  const snaps: BlockSnapshot[] = [];
  doc.forEach((node) => {
    snaps.push(node.toJSON() as BlockSnapshot);
  });
  return fingerprintBlocks(snaps);
}

/**
 * Collect image files from a clipboard or drag `DataTransfer`. Returns
 * only entries whose MIME type is `image/*`; an empty array means the
 * paste / drop carried no images and callers should fall through to the
 * editor's default handling (text, HTML, in-editor block reorder, etc.).
 *
 * Both `DataTransfer.files` and `DataTransfer.items` are inspected:
 * screenshots / file copies populate `files`, but pasted images from
 * many apps only surface via `items` (kind `file`). Without the `items`
 * fallback the paste falls through to the browser default, which
 * inserts an ephemeral `blob:` `<img>` — exactly what this feature
 * exists to avoid.
 */
export function extractImageFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const files: File[] = [];
  const seen = new Set<File>();
  for (const file of Array.from(dt.files)) {
    if (file.type.startsWith('image/') && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  if (dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

/** Strip the extension from a filename for use as image alt text. */
export function fileNameToAlt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '').trim();
}

export interface MilkdownFactoryOptions {
  /** Element the editor view will be mounted into. */
  root: HTMLElement;
  /** Initial markdown payload. */
  initialMarkdown: string;
  /** Default `true`. */
  editable?: boolean;
  /** Optional placeholder text shown when the doc is empty. */
  placeholder?: string;
  /** Accessible name applied to the ProseMirror textbox. */
  ariaLabel?: string;
  /** Which selection toolbar surface should be active. Default `huabu`. */
  toolbarMode?: 'none' | 'huabu';
  /**
   * Resolve an image node's stored `src` (a bare artifact key such as
   * `art_abc.png`, or a legacy full URL) into a fetchable URL for the
   * rendered `<img>`. The stored attribute — and therefore the
   * serialized markdown — is left untouched, so the document and the
   * `onChange` payload keep the canonical bare key. Defaults to identity
   * (used by test / preview surfaces that have no canvas context).
   */
  resolveImageSrc?: (src: string) => string;
  /**
   * Upload a pasted or dropped image file and resolve to the bare
   * artifact key to persist (e.g. `art_abc.png`). When omitted, image
   * paste / drop is not intercepted and the editor's default handling
   * runs. Errors are surfaced by the factory via a toast.
   */
  uploadImage?: (file: File) => Promise<string>;
  /**
   * Import an image referenced by a copied canvas node and resolve to the
   * artifact key that belongs in this editor's canvas. The host owns
   * cross-canvas cloning because the factory has no canvas API dependency.
   */
  importImage?: (image: {
    src: string;
    srcCanvasId?: string;
  }) => Promise<string>;
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
  /** Resolved doc range covered by the drag, in ProseMirror positions. */
  range: MilkdownDragRange;
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

export interface MilkdownTextRange {
  from: number;
  to: number;
}

export interface MilkdownLinkState {
  href: string;
  range: MilkdownTextRange;
}

export interface MilkdownInlineMathState {
  value: string;
  range: MilkdownTextRange;
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
  /** Update the ProseMirror textbox's accessible name. */
  setAriaLabel(label: string): void;
  /** Current block, inline mark, and color state for toolbar rendering. */
  getFormattingState(): MilkdownFormattingState;
  /** Subscribe to formatting-state changes after editor transactions. */
  onFormattingUpdated(
    listener: (state: MilkdownFormattingState) => void,
  ): () => void;
  /** Test-only helper: select the current top-level block as Crepe's block handle does. */
  __selectCurrentBlockForTest?(): void;
  /** Test-only helper: select the document's text content. */
  __selectAllTextForTest?(): void;
  /** Test-only helper: select from the first occurrence of one text to another. */
  __selectTextBetweenForTest?(fromText: string, toText: string): void;
  /** Test-only helper: serialize the active ProseMirror dragging slice. */
  __getDraggingMarkdownForTest?(): string | null;
  /** Test-only helper: place the cursor after the first text occurrence. */
  __setCursorAfterTextForTest?(text: string): void;
  /** Test-only helper: node-select the list item containing the first text occurrence. */
  __selectListItemContainingTextForTest?(text: string): void;
  /** Test-only helper: text-select a list item as a range at the list level (mimics the block handle). */
  __selectListItemAsRangeForTest?(text: string): void;
  /** Test-only helper: dispatch a keydown on the editor DOM. */
  __dispatchKeyDownForTest?(key: string, shiftKey?: boolean): void;
  /** Viewport rect for the current non-empty editor selection. */
  getSelectionClientRect(): DOMRect | null;
  /** Current text selection range, in ProseMirror doc positions. */
  getSelectionRange(includeEmpty?: boolean): MilkdownTextRange | null;
  /** Plain text in the current non-empty text selection. */
  getSelectionText(): string | null;
  /** Active link under the current selection or cursor. */
  getActiveLink(): MilkdownLinkState | null;
  /** Active inline math node under the current selection. */
  getActiveInlineMath(): MilkdownInlineMathState | null;
  /** Toggle an inline mark at the current selection. */
  toggleMark(mark: MilkdownInlineMark): void;
  /** Convert the current block while preserving its content where possible. */
  setBlockType(type: MilkdownBlockType): void;
  /** Apply or clear a semantic text color mark. */
  setTextColor(color: MilkdownTextColor | null): void;
  /** Apply or clear a semantic background/highlight color mark. */
  setBackgroundColor(color: MilkdownBackgroundColor | null): void;
  /** Apply or clear a link mark at the current selection. */
  setLink(href: string | null, range?: MilkdownTextRange | null): void;
  /** Insert an inline math scaffold at the current selection. */
  insertInlineMath(): void;
  /** Insert or update an inline math node. */
  setInlineMath(value: string, range?: MilkdownTextRange | null): void;
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
  /** Align ProseMirror's native drag selection with a resolved full-block range. */
  setDragSelection(range: MilkdownDragRange): void;
  /** Register the full-block slice consumed by ProseMirror's native drop handler. */
  setDraggingSlice(range: MilkdownDragRange): void;
  /** Clear native dragging state after a drop outside this editor or a cancelled drag. */
  clearDraggingSlice(): void;
  /** Resolve the enclosing drag-block range for a DOM node inside the editor. */
  getDragRangeAtDOM(target: globalThis.Node): MilkdownDragRange | null;
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

  /**
   * Return the markdown the doc would hold if `range` were deleted —
   * WITHOUT mutating the editor. Returns the current full markdown
   * when `range` is null or empty.
   */
  getDocAfterRangeRemoved(range: MilkdownDragRange | null): string;

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
   * Insert one or more blocks parsed from `markdown` exactly where the
   * drop indicator (the blue bar) is currently showing.
   *
   * The position is read straight out of `prosemirror-drop-indicator`'s
   * own state rather than recomputed, so what the user sees and what
   * lands can't disagree. That plugin picks its target by geometric
   * proximity to every block edge at every depth, which no
   * coordinate-to-position heuristic of ours reproduces.
   *
   * Returns `false` when no indicator is showing (the pointer never
   * hovered the editor surface, or the cursor feature is disabled);
   * the caller decides the fallback (e.g. append to the end). Call it
   * from a drop handler, before `clearDropIndicator`.
   */
  insertBlocksAtDropIndicator(markdown: string): boolean;
  /**
   * Replace the active block-decoration set. Each entry highlights the
   * top-level block whose fingerprint key matches by adding `className`
   * via a `Decoration.node`. Pass `[]` to clear.
   */
  setBlockDecorations(
    specs: ReadonlyArray<{ key: string; className: string }>,
  ): void;

  /**
   * Force the drop indicator (the blue insertion bar drawn by
   * `prosemirror-drop-indicator`) to disappear. It only hides on a
   * `drop` / `dragend` / `dragleave` observed on `view.dom`. When a
   * host handler claims the drop in the capture phase (so the
   * plugin's listener never fires) AND the drag source lives outside
   * this editor (so the browser's follow-up `dragend` fires on the
   * source, not on `view.dom`), the bar would otherwise linger. Call
   * this from your drop handler after the insertion is committed.
   */
  clearDropIndicator(): void;

  /**
   * Move the browser focus into the editor's contenteditable surface.
   * Safe to call after mount; no-op once the view has been destroyed.
   * Used by hosts that want the user's caret to land in the editor as
   * soon as it opens (e.g. expanding a note node).
   */
  focus(): void;

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
const TEXT_COLOR_MARK_NAME = 'huabu_text_color';
const BACKGROUND_COLOR_MARK_NAME = 'huabu_background_color';
const HUABU_COLOR_MARKDOWN_NODE_TYPE = 'huabuColorSpan';

type HuabuColorDataAttr =
  | 'data-huabu-text-color'
  | 'data-huabu-background-color';

const LEGACY_COLOR_DATA_ATTRS: Record<HuabuColorDataAttr, string> = {
  'data-huabu-text-color': 'data-sediment-text-color',
  'data-huabu-background-color': 'data-sediment-background-color',
};

interface MarkdownNodeLike {
  type: string;
  value?: unknown;
  children?: MarkdownNodeLike[];
  [key: string]: unknown;
}

interface HuabuColorMarkdownNode extends MarkdownNodeLike {
  type: typeof HUABU_COLOR_MARKDOWN_NODE_TYPE;
  dataAttr: HuabuColorDataAttr;
  token: AccentToken;
  children: MarkdownNodeLike[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtml(value: string): string {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function colorCssForAccent(
  token: AccentToken,
  kind: 'text' | 'background',
): string {
  const accent = resolveAccent(token) ?? token;
  const tokens = getAccentTokens(accent);
  return kind === 'text' ? tokens.fg : tokens.highlightBg;
}

function normalizeSafeLinkHref(href: string | null | undefined): string | null {
  const trimmed = href?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

function parseOpeningColorSpanHtml(value: unknown): Array<{
  dataAttr: HuabuColorDataAttr;
  token: AccentToken;
}> {
  if (typeof value !== 'string') return [];
  const match = value.match(/^<span\b([^>]*)>$/i);
  if (!match) return [];
  const attrs = match[1] ?? '';
  const parsed: Array<{ dataAttr: HuabuColorDataAttr; token: AccentToken }> =
    [];
  for (const dataAttr of [
    'data-huabu-text-color',
    'data-huabu-background-color',
  ] as const) {
    const acceptedAttrs = [dataAttr, LEGACY_COLOR_DATA_ATTRS[dataAttr]];
    const tokenMatch = attrs.match(
      new RegExp(`(?:${acceptedAttrs.join('|')})=["']([^"']+)["']`, 'i'),
    );
    const token = tokenMatch?.[1];
    if (isAccentToken(token)) parsed.push({ dataAttr, token });
  }
  return parsed;
}

function isClosingSpanHtml(node: MarkdownNodeLike | undefined): boolean {
  return node?.type === 'html' && /^<\/span>$/i.test(String(node.value ?? ''));
}

function collapseHuabuColorSpanNodes(node: MarkdownNodeLike): void {
  if (!Array.isArray(node.children)) return;

  for (const child of node.children) collapseHuabuColorSpanNodes(child);

  const nextChildren: MarkdownNodeLike[] = [];
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index];
    if (child?.type !== 'html') {
      nextChildren.push(child);
      continue;
    }

    const parsed = parseOpeningColorSpanHtml(child.value);
    if (parsed.length === 0) {
      nextChildren.push(child);
      continue;
    }

    const closeIndex = node.children.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index && isClosingSpanHtml(candidate),
    );
    if (closeIndex === -1) {
      nextChildren.push(child);
      continue;
    }

    let children = node.children.slice(index + 1, closeIndex);
    for (const color of parsed.slice().reverse()) {
      children = [
        {
          type: HUABU_COLOR_MARKDOWN_NODE_TYPE,
          dataAttr: color.dataAttr,
          token: color.token,
          children,
        } satisfies HuabuColorMarkdownNode,
      ];
    }
    nextChildren.push(...children);
    index = closeIndex;
  }
  node.children = nextChildren;
}

const huabuColorSpanRemarkPlugin = $remark(
  'huabuColorSpan',
  () => () => (tree) => {
    collapseHuabuColorSpanNodes(tree as MarkdownNodeLike);
  },
);

function parseColorSpanHtml(
  value: unknown,
  dataAttr: HuabuColorDataAttr,
  kind: 'text' | 'background',
): { token: AccentToken; color: string; text: string } | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^<span\b([^>]*)>([\s\S]*)<\/span>$/i);
  if (!match) return null;
  const [, attrs = '', rawText = ''] = match;
  const acceptedAttrs = [dataAttr, LEGACY_COLOR_DATA_ATTRS[dataAttr]];
  const tokenMatch = attrs.match(
    new RegExp(`(?:${acceptedAttrs.join('|')})=["']([^"']+)["']`, 'i'),
  );
  const token = tokenMatch?.[1];
  if (!isAccentToken(token)) return null;
  return {
    token,
    color: colorCssForAccent(token, kind),
    text: decodeHtml(rawText),
  };
}

function isHuabuColorMarkdownNode(
  node: MarkdownNodeLike,
  dataAttr: HuabuColorDataAttr,
): node is HuabuColorMarkdownNode {
  return (
    node.type === HUABU_COLOR_MARKDOWN_NODE_TYPE &&
    node.dataAttr === dataAttr &&
    isAccentToken(node.token) &&
    Array.isArray(node.children)
  );
}

function markToken(mark: Mark | null | undefined): AccentToken | null {
  const token = mark?.attrs.token;
  return isAccentToken(token) ? token : null;
}

function markColor(mark: Mark | null | undefined): string | null {
  const color = mark?.attrs.color;
  return typeof color === 'string' && color.length > 0 ? color : null;
}

function colorMarkForNode(
  node: ProseNode,
  name: typeof TEXT_COLOR_MARK_NAME | typeof BACKGROUND_COLOR_MARK_NAME,
): Mark | null {
  return node.marks.find((mark) => mark.type.name === name) ?? null;
}

function createAccentColorMarkSchema(
  name: typeof TEXT_COLOR_MARK_NAME | typeof BACKGROUND_COLOR_MARK_NAME,
  dataAttr: 'data-huabu-text-color' | 'data-huabu-background-color',
  cssProp: 'color' | 'background-color',
  kind: 'text' | 'background',
) {
  return $markSchema(name, () => ({
    excludes: name,
    attrs: {
      token: { default: '', validate: 'string' },
      color: { default: '', validate: 'string' },
    },
    parseDOM: [
      {
        tag: `span[${dataAttr}]`,
        getAttrs: (dom: HTMLElement) => {
          const token = dom.getAttribute(dataAttr);
          if (!isAccentToken(token)) return false;
          return { token, color: colorCssForAccent(token, kind) };
        },
      },
    ],
    toDOM: (mark) => {
      const token = mark.attrs.token;
      const color = mark.attrs.color;
      return [
        'span',
        {
          [dataAttr]: token,
          style: `${cssProp}: ${color}`,
        },
        0,
      ];
    },
    parseMarkdown: {
      match: (node) =>
        isHuabuColorMarkdownNode(node as MarkdownNodeLike, dataAttr) ||
        parseColorSpanHtml(node.value, dataAttr, kind) !== null,
      runner: (state, node, markType) => {
        if (isHuabuColorMarkdownNode(node as MarkdownNodeLike, dataAttr)) {
          const colorNode = node as HuabuColorMarkdownNode;
          state.openMark(markType, {
            token: colorNode.token,
            color: colorCssForAccent(colorNode.token, kind),
          });
          state.next(colorNode.children);
          state.closeMark(markType);
          return;
        }

        const parsed = parseColorSpanHtml(node.value, dataAttr, kind);
        if (!parsed) return;
        state.openMark(markType, {
          token: parsed.token,
          color: parsed.color,
        });
        state.addText(parsed.text);
        state.closeMark(markType);
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === name,
      runner: (state, mark, node) => {
        const textColorMark = colorMarkForNode(node, TEXT_COLOR_MARK_NAME);
        const backgroundColorMark = colorMarkForNode(
          node,
          BACKGROUND_COLOR_MARK_NAME,
        );
        if (name === BACKGROUND_COLOR_MARK_NAME && textColorMark) return false;

        const textToken = markToken(textColorMark);
        const backgroundToken = markToken(backgroundColorMark);
        const styleParts: string[] = [];
        if (textColorMark) {
          styleParts.push(`color: ${markColor(textColorMark) ?? ''}`);
        }
        if (backgroundColorMark) {
          styleParts.push(
            `background-color: ${markColor(backgroundColorMark) ?? ''}`,
          );
        }
        const attrs = [
          textToken ? `data-huabu-text-color="${escapeHtml(textToken)}"` : null,
          backgroundToken
            ? `data-huabu-background-color="${escapeHtml(backgroundToken)}"`
            : null,
          styleParts.length > 0
            ? `style="${escapeHtml(styleParts.join('; '))}"`
            : null,
        ].filter(Boolean);
        const text = node.text ?? '';
        state.withMark(
          mark,
          'html',
          `<span ${attrs.join(' ')}>${escapeHtml(text)}</span>`,
        );
        return true;
      },
    },
  }));
}

const textColorMarkSchema = createAccentColorMarkSchema(
  TEXT_COLOR_MARK_NAME,
  'data-huabu-text-color',
  'color',
  'text',
);

const backgroundColorMarkSchema = createAccentColorMarkSchema(
  BACKGROUND_COLOR_MARK_NAME,
  'data-huabu-background-color',
  'background-color',
  'background',
);

const INLINE_MARK_NAMES: Record<MilkdownInlineMark, string> = {
  bold: 'strong',
  italic: 'emphasis',
  strike: 'strike_through',
  inlineCode: 'inlineCode',
};

function getMarkType(ctx: Ctx, name: string): MarkType | null {
  const schema = ctx.get(schemaCtx);
  return schema.marks[name] ?? null;
}

function selectionHasMark(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
  }
  return state.doc.rangeHasMark(from, to, type);
}

function activeAccentToken(
  state: EditorState,
  type: MarkType | null,
): AccentToken | null {
  if (!type) return null;
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const token = type.isInSet(marks)?.attrs.token;
  return isAccentToken(token) ? token : null;
}

function markRangeAt(
  state: EditorState,
  markType: MarkType,
): (MilkdownTextRange & { attrs: Record<string, unknown> }) | null {
  const { selection } = state;
  const from = selection.empty
    ? Math.max(0, selection.from - 2)
    : selection.from;
  const to = selection.empty
    ? Math.min(state.doc.content.size, selection.from + 2)
    : selection.to;
  let result: (MilkdownTextRange & { attrs: Record<string, unknown> }) | null =
    null;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (result || !node.isText) return;
    const mark = markType.isInSet(node.marks);
    if (!mark) return;
    let rangeFrom = pos;
    let rangeTo = pos + node.nodeSize;
    const parentStart = pos - state.doc.resolve(pos).parentOffset;
    const parent = state.doc.resolve(pos).parent;
    let offset = 0;
    parent.forEach((child) => {
      const childFrom = parentStart + offset;
      const childTo = childFrom + child.nodeSize;
      if (childTo <= rangeFrom || childFrom >= rangeTo) {
        offset += child.nodeSize;
        return;
      }
      if (markType.isInSet(child.marks)) {
        rangeFrom = Math.min(rangeFrom, childFrom);
        rangeTo = Math.max(rangeTo, childTo);
      }
      offset += child.nodeSize;
    });
    result = { from: rangeFrom, to: rangeTo, attrs: mark.attrs };
  });
  return result;
}

function inlineMathRangeAt(state: EditorState): MilkdownInlineMathState | null {
  const { selection } = state;
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === 'math_inline'
  ) {
    return {
      value: String(selection.node.attrs.value ?? ''),
      range: { from: selection.from, to: selection.to },
    };
  }

  const from = selection.empty
    ? Math.max(0, selection.from - 1)
    : selection.from;
  const to = selection.empty ? selection.from : selection.to;
  let result: MilkdownInlineMathState | null = null;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (result || node.type.name !== 'math_inline') return;
    result = {
      value: String(node.attrs.value ?? ''),
      range: { from: pos, to: pos + node.nodeSize },
    };
  });
  return result;
}

function setAccentColorMark(
  ctx: Ctx,
  markName: typeof TEXT_COLOR_MARK_NAME | typeof BACKGROUND_COLOR_MARK_NAME,
  token: AccentToken | null,
  kind: 'text' | 'background',
): void {
  const view = ctx.get(editorViewCtx);
  const markType = getMarkType(ctx, markName);
  if (!markType) return;

  const { state } = view;
  const { from, to, empty } = state.selection;
  const tr = state.tr;
  if (empty) {
    tr.removeStoredMark(markType);
  } else {
    tr.removeMark(from, to, markType);
  }

  if (token) {
    const mark = markType.create({
      token,
      color: colorCssForAccent(token, kind),
    });
    if (empty) {
      tr.addStoredMark(mark);
    } else {
      tr.addMark(from, to, mark);
    }
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
}

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

function insertNodeAtSelection(ctx: Ctx, type: NodeType): void {
  const view = ctx.get(editorViewCtx);
  const node = type.createAndFill() ?? type.create();
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
  view.focus();
}

/**
 * Strip the indentation a whole markdown fragment shares.
 *
 * Markdown extracted from nested content (e.g. a paragraph inside a nested
 * list item) carries that nesting's indentation. Re-parsed at top level, four
 * or more leading spaces would silently become an indented code block. Our own
 * serializer always fences real code blocks, so a uniformly indented fragment
 * is a nesting artifact rather than intended code.
 */
function dedentMarkdownFragment(markdown: string): string {
  const lines = markdown.split('\n');
  let common: number | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) return markdown;
    if (common === null || indent < common) common = indent;
  }
  if (common === null) return markdown;
  return lines
    .map((line) => (line.trim().length === 0 ? line : line.slice(common)))
    .join('\n');
}

function parseTopLevelMarkdown(ctx: Ctx, markdown: string): ProseNode[] {
  const parsed = ctx.get(parserCtx)(dedentMarkdownFragment(markdown));
  const nodes: ProseNode[] = [];
  parsed?.forEach((node) => nodes.push(node));
  return nodes;
}

function currentTopLevelBlockRange(state: EditorState): {
  from: number;
  to: number;
  text: string;
  nodeName: string;
} | null {
  if (state.selection instanceof NodeSelection) {
    const { $from, from, to, node } = state.selection;
    if ($from.parent.type.name === 'doc') {
      return {
        from,
        to,
        text: node.textBetween(0, node.content.size, ' ').trim() || ' ',
        nodeName: node.type.name,
      };
    }
  }

  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth - 1).type.name !== 'doc') continue;
    const node = $from.node(depth);
    const from = $from.before(depth);
    const to = $from.after(depth);
    return {
      from,
      to,
      text: node.textBetween(0, node.content.size, ' ').trim() || ' ',
      nodeName: node.type.name,
    };
  }
  return null;
}

function currentListItemRange(state: EditorState): {
  from: number;
  to: number;
  index: number;
  listFrom: number;
  listTo: number;
  listNode: ProseNode;
  text: string;
} | null {
  if (
    state.selection instanceof NodeSelection &&
    state.selection.node.type.name === 'list_item'
  ) {
    const listDepth = state.selection.$from.depth;
    const listNode = state.selection.$from.node(listDepth);
    if (['bullet_list', 'ordered_list'].includes(listNode.type.name)) {
      return {
        from: state.selection.from,
        to: state.selection.to,
        index: state.selection.$from.index(listDepth),
        listFrom: state.selection.$from.before(listDepth),
        listTo: state.selection.$from.after(listDepth),
        listNode,
        text:
          state.selection.node
            .textBetween(0, state.selection.node.content.size, ' ')
            .trim() || ' ',
      };
    }
  }

  const { $from } = state.selection;

  // The block handle presents a nested list item as a TextSelection whose
  // `$from` resolves to the *list* level — directly inside the containing
  // `bullet_list` / `ordered_list`, positioned before the target item —
  // rather than inside the item's own text. Walking up from there would
  // wrongly grab the ancestor list_item (the parent). Detect this case and
  // target the item at the selection's start index within that list.
  const startNode = $from.node($from.depth);
  if (
    ['bullet_list', 'ordered_list'].includes(startNode.type.name) &&
    $from.index($from.depth) < startNode.childCount
  ) {
    const listDepth = $from.depth;
    const index = $from.index(listDepth);
    const item = startNode.child(index);
    const itemFrom = $from.posAtIndex(index, listDepth);
    return {
      from: itemFrom,
      to: itemFrom + item.nodeSize,
      index,
      listFrom: $from.before(listDepth),
      listTo: $from.after(listDepth),
      listNode: startNode,
      text: item.textBetween(0, item.content.size, ' ').trim() || ' ',
    };
  }

  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== 'list_item') continue;
    const listDepth = depth - 1;
    const listNode = $from.node(listDepth);
    if (!['bullet_list', 'ordered_list'].includes(listNode.type.name)) {
      continue;
    }
    const node = $from.node(depth);
    let index = 0;
    listNode.forEach((child, _offset, childIndex) => {
      if (child === node) index = childIndex;
    });
    return {
      from: $from.before(depth),
      to: $from.after(depth),
      index,
      listFrom: $from.before(listDepth),
      listTo: $from.after(listDepth),
      listNode,
      text: node.textBetween(0, node.content.size, ' ').trim() || ' ',
    };
  }
  return null;
}

function textInsertionPosForNodeSelection(
  state: EditorState,
  selection: NodeSelection,
): number | null {
  const from = selection.from;
  let result: number | null = null;
  selection.node.descendants((node, pos) => {
    if (result !== null) return false;
    if (node.isTextblock) {
      result = from + pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  if (result === null && selection.node.isTextblock) {
    result = from + 1 + selection.node.content.size;
  }
  if (result === null) return null;
  return Math.max(0, Math.min(result, state.doc.content.size));
}

function markdownForBlockType(key: MilkdownBlockType, text: string): string {
  if (key === 'paragraph') return `${text}\n`;
  if (key.startsWith('heading-')) {
    return `${'#'.repeat(Number(key.slice(-1)))} ${text}\n`;
  }
  if (key === 'blockquote') return `> ${text}\n`;
  if (key === 'bullet-list') return `- ${text}\n`;
  if (key === 'ordered-list') return `1. ${text}\n`;
  if (key === 'task-list') return `- [ ] ${text}\n`;
  if (key === 'code-block') return `\`\`\`\n${text}\n\`\`\`\n`;
  if (key === 'math') return `\`\`\`LaTeX\n${text}\n\`\`\`\n`;
  if (key === 'divider') return '---\n';
  return `${text}\n`;
}

function replaceCurrentTopLevelBlockWithMarkdown(
  ctx: Ctx,
  markdown: string,
): void {
  const view = ctx.get(editorViewCtx);
  const range = currentTopLevelBlockRange(view.state);
  if (!range) return;
  const nodes = parseTopLevelMarkdown(ctx, markdown);
  if (nodes.length === 0) return;
  const tr = view.state.tr.replaceWith(
    range.from,
    range.to,
    nodes as unknown as Fragment,
  );
  const selectionPos = Math.min(range.from + 1, tr.doc.content.size);
  view.dispatch(
    tr
      .setSelection(TextSelection.near(tr.doc.resolve(selectionPos)))
      .scrollIntoView(),
  );
  view.focus();
}

/**
 * Turn a multi-block text selection into a single list, one item per block.
 *
 * Only plain top-level paragraphs / headings qualify: lists, tables, quotes,
 * and code blocks keep their dedicated structure-preserving paths. The blocks'
 * inline content is moved as-is rather than re-parsed from text, so bold,
 * links, and color marks survive the conversion.
 *
 * Returns `false` when the selection doesn't qualify, so the caller can fall
 * back to the single-block path.
 */
function convertSelectedBlocksToList(
  ctx: Ctx,
  key: 'bullet-list' | 'ordered-list' | 'task-list',
): boolean {
  const view = ctx.get(editorViewCtx);
  const state = view.state;
  if (state.selection instanceof NodeSelection) return false;
  const { from: selectionFrom, to: selectionTo } = state.selection;
  if (selectionFrom === selectionTo) return false;

  const schema = state.schema;
  const listType =
    key === 'ordered-list'
      ? schema.nodes.ordered_list
      : schema.nodes.bullet_list;
  const itemType = schema.nodes.list_item;
  const paragraphType = schema.nodes.paragraph;
  if (!listType || !itemType || !paragraphType) return false;

  const itemAttrs = {
    listType: key === 'ordered-list' ? 'ordered' : 'bullet',
    checked: key === 'task-list' ? false : null,
  };

  let rangeFrom: number | null = null;
  let rangeTo = 0;
  const items: ProseNode[] = [];
  let supported = true;

  state.doc.forEach((node, offset) => {
    if (!supported) return;
    const end = offset + node.nodeSize;
    if (end <= selectionFrom || offset >= selectionTo) return;
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') {
      supported = false;
      return;
    }
    if (rangeFrom === null) rangeFrom = offset;
    rangeTo = end;
    items.push(
      itemType.create(itemAttrs, paragraphType.create(null, node.content)),
    );
  });

  if (!supported || rangeFrom === null || items.length < 2) return false;

  const tr = state.tr.replaceWith(
    rangeFrom,
    rangeTo,
    listType.create(null, items),
  );
  // Keep the converted blocks selected so the user can chain another action.
  const start = Math.min(rangeFrom + 2, tr.doc.content.size);
  const end = Math.max(start, Math.min(rangeTo, tr.doc.content.size));
  view.dispatch(
    tr
      .setSelection(
        TextSelection.between(tr.doc.resolve(start), tr.doc.resolve(end)),
      )
      .scrollIntoView(),
  );
  view.focus();
  return true;
}

function replaceCurrentTopLevelBlockWithList(
  ctx: Ctx,
  key: 'bullet-list' | 'ordered-list' | 'task-list',
): void {
  const view = ctx.get(editorViewCtx);

  // A block-handle (NodeSelection) on a nested list item resolves to the whole
  // enclosing top-level list. Converting it must preserve the list's structure:
  // the fall-through below flattens every item's text into a single line, which
  // merges the parent and child rows. Convert every list node and list_item in
  // the selected subtree to the target type in place instead.
  //
  // Both the parent list node type AND each `list_item`'s `listType` attr must
  // change together: a Milkdown plugin keeps them in sync and reverts partial
  // edits, so changing only one is a silent no-op.
  const { selection } = view.state;
  if (
    selection instanceof NodeSelection &&
    (selection.node.type.name === 'bullet_list' ||
      selection.node.type.name === 'ordered_list')
  ) {
    const targetListType =
      key === 'ordered-list'
        ? view.state.schema.nodes.ordered_list
        : view.state.schema.nodes.bullet_list;
    if (!targetListType) return;
    const targetItemListType = key === 'ordered-list' ? 'ordered' : 'bullet';
    const checkedValue = key === 'task-list' ? false : null;
    const tr = view.state.tr;
    view.state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (
        node.type.name === 'bullet_list' ||
        node.type.name === 'ordered_list'
      ) {
        tr.setNodeMarkup(pos, targetListType, null);
      } else if (node.type.name === 'list_item') {
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          listType: targetItemListType,
          checked: checkedValue,
        });
      }
    });
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return;
  }

  const listItemRange = currentListItemRange(view.state);
  if (listItemRange) {
    const targetListType =
      key === 'ordered-list'
        ? view.state.schema.nodes.ordered_list
        : view.state.schema.nodes.bullet_list;
    if (!targetListType) return;
    const targetItemListType = key === 'ordered-list' ? 'ordered' : 'bullet';
    const checkedValue = key === 'task-list' ? false : null;

    // Reuse the original list_item's content (including any nested
    // sub-lists) instead of flattening its text. Flattening via
    // `listItemRange.text` + re-parse merges the item and its nested rows
    // into a single line. Only the item's own marker type changes; its
    // `listType` attr must match the new parent list type or a Milkdown
    // sync plugin reverts the change.
    const originalItem = listItemRange.listNode.child(listItemRange.index);
    const convertedItem = originalItem.type.create(
      {
        ...originalItem.attrs,
        listType: targetItemListType,
        checked: checkedValue,
      },
      originalItem.content,
    );
    const replacementList = targetListType.create(null, [convertedItem]);

    const beforeItems: ProseNode[] = [];
    const afterItems: ProseNode[] = [];
    listItemRange.listNode.forEach((child, _offset, childIndex) => {
      if (childIndex < listItemRange.index) beforeItems.push(child);
      if (childIndex > listItemRange.index) afterItems.push(child);
    });

    const replacementNodes: ProseNode[] = [];
    if (beforeItems.length > 0) {
      replacementNodes.push(
        listItemRange.listNode.type.create(
          listItemRange.listNode.attrs,
          beforeItems,
        ),
      );
    }
    const replacementStartOffset = replacementNodes.reduce(
      (offset, node) => offset + node.nodeSize,
      0,
    );
    replacementNodes.push(replacementList);
    if (afterItems.length > 0) {
      replacementNodes.push(
        listItemRange.listNode.type.create(
          listItemRange.listNode.attrs,
          afterItems,
        ),
      );
    }

    const tr = view.state.tr.replaceWith(
      listItemRange.listFrom,
      listItemRange.listTo,
      replacementNodes,
    );
    const selectionPos = Math.min(
      listItemRange.listFrom + replacementStartOffset + 2,
      tr.doc.content.size,
    );
    view.dispatch(
      tr
        .setSelection(TextSelection.near(tr.doc.resolve(selectionPos)))
        .scrollIntoView(),
    );
    view.focus();
    return;
  }

  const range = currentTopLevelBlockRange(view.state);
  if (!range) return;
  const text = range.text;
  replaceCurrentTopLevelBlockWithMarkdown(ctx, markdownForBlockType(key, text));
}

function replaceCurrentTopLevelBlockWithTable(ctx: Ctx): void {
  replaceCurrentTopLevelBlockWithMarkdown(
    ctx,
    '|   |   |   |\n| --- | --- | --- |\n|   |   |   |\n|   |   |   |\n',
  );
}
/**
 * Resolve which supported block type describes the block under the current
 * selection's `$from`.
 */
function blockTypeKeyForNode(node: ProseNode): MilkdownBlockType | null {
  const name = node.type.name;
  if (name === 'heading') {
    const level = node.attrs.level;
    if (level === 1) return 'heading-1';
    if (level === 2) return 'heading-2';
    if (level === 3) return 'heading-3';
    if (level === 4) return 'heading-4';
    if (level === 5) return 'heading-5';
    if (level === 6) return 'heading-6';
    return null;
  }
  if (name === 'code_block') {
    return node.attrs.language === 'LaTeX' ? 'math' : 'code-block';
  }
  if (name === 'hr') return 'divider';
  if (name === 'table') return 'table';
  if (name === 'blockquote') return 'blockquote';
  if (name === 'bullet_list') return 'bullet-list';
  if (name === 'ordered_list') return 'ordered-list';
  if (name === 'list_item' && node.attrs.checked !== null) return 'task-list';
  if (name === 'paragraph') return 'paragraph';
  return null;
}

function resolveBlockTypeKey(state: EditorState): MilkdownBlockType | null {
  if (state.selection instanceof NodeSelection) {
    const selected = blockTypeKeyForNode(state.selection.node);
    if (selected) return selected;
  }

  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    const blockType = blockTypeKeyForNode(node);
    if (
      blockType &&
      ![
        'paragraph',
        'blockquote',
        'bullet-list',
        'ordered-list',
        'task-list',
      ].includes(blockType)
    ) {
      return blockType;
    }
  }
  // Wrappers second — a paragraph nested in a list should still surface
  // the list (more "useful" type) for the trigger, but a plain
  // top-level paragraph shows paragraph.
  for (let depth = $from.depth; depth >= 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === 'blockquote') return 'blockquote';
    if (name === 'bullet_list') return 'bullet-list';
    if (name === 'ordered_list') return 'ordered-list';
    if (name === 'list_item' && $from.node(depth).attrs.checked !== null) {
      return 'task-list';
    }
  }
  return 'paragraph';
}

/** Schema node-name used to invoke the underlying PM command for a key. */
const BLOCK_TYPE_NODE_NAME: Record<MilkdownBlockType, string> = {
  paragraph: 'paragraph',
  'heading-1': 'heading',
  'heading-2': 'heading',
  'heading-3': 'heading',
  'heading-4': 'heading',
  'heading-5': 'heading',
  'heading-6': 'heading',
  blockquote: 'blockquote',
  divider: 'hr',
  'bullet-list': 'bullet_list',
  'ordered-list': 'ordered_list',
  'task-list': 'bullet_list',
  table: 'table',
  math: 'code_block',
  'code-block': 'code_block',
};

/** Run the PM "turn into" command for a given block-type key. */
function runBlockTypeCommand(ctx: Ctx, key: MilkdownBlockType): void {
  const view = ctx.get(editorViewCtx);

  // A selection spanning several blocks must convert all of them, not only
  // the block holding `$from`. Tables keep their single-block replacement.
  // A selection spanning several blocks must convert all of them, not only
  // the block holding `$from`. Other block types already apply across the
  // whole range through ProseMirror's own commands below.
  if (key === 'bullet-list' || key === 'ordered-list' || key === 'task-list') {
    if (!convertSelectedBlocksToList(ctx, key)) {
      replaceCurrentTopLevelBlockWithList(ctx, key);
    }
    return;
  }

  // A block-handle (NodeSelection) selection on a list item must not fall
  // through to the whole-top-level-block replacement below: for a nested
  // item, `currentTopLevelBlockRange` resolves to the *entire* enclosing
  // list, so replacing it would merge the parent item's text into the
  // target block (e.g. turning a child into a paragraph would swallow the
  // parent). Collapse the selection to a caret inside the item so the
  // list-item lifting path handles it exactly like a caret selection.
  if (
    view.state.selection instanceof NodeSelection &&
    view.state.selection.node.type.name === 'list_item'
  ) {
    const insidePos = Math.min(
      view.state.selection.from + 1,
      view.state.doc.content.size,
    );
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(insidePos)),
      ),
    );
  }

  const sourceRange = currentTopLevelBlockRange(view.state);
  if (
    sourceRange &&
    key !== 'table' &&
    (view.state.selection instanceof NodeSelection ||
      sourceRange.nodeName === 'table')
  ) {
    replaceCurrentTopLevelBlockWithMarkdown(
      ctx,
      markdownForBlockType(key, sourceRange.text),
    );
    return;
  }

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
  } else if (key.startsWith('heading-')) {
    runCommand(ctx, setBlockType(type, { level: Number(key.slice(-1)) }));
  } else if (key === 'divider') {
    insertNodeAtSelection(ctx, type);
  } else if (key === 'code-block') {
    runCommand(ctx, setBlockType(type));
  } else if (key === 'math') {
    runCommand(ctx, setBlockType(type, { language: 'LaTeX' }));
  } else if (key === 'blockquote') {
    runCommand(ctx, wrapIn(type));
  } else if (key === 'table') {
    replaceCurrentTopLevelBlockWithTable(ctx);
  }
}

/**
 * Follow the link under the cursor on a modifier-click, and block clicks on
 * links the app would never create itself.
 *
 * A plain click has to keep placing the caret so link text stays editable, so
 * navigation is bound to the platform's "follow" modifier instead — `Cmd` on
 * macOS, where `Ctrl`-click is the secondary-click gesture, and `Ctrl`
 * elsewhere.
 *
 * The href is validated here rather than trusted from the mark: only `setLink`
 * screens what the user types, while markdown parsed from an agent reply, a
 * paste or a synced file renders its `href` verbatim — so a `javascript:`
 * target can reach the DOM. Anchors are the one place such a URL can still be
 * activated (a click), so an unsafe href has its default suppressed while the
 * event keeps flowing to ProseMirror's own selection handling.
 */
function handleLinkClick(view: EditorView, event: Event): boolean {
  const mouseEvent = event as MouseEvent;
  const target = mouseEvent.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest('a[href]');
  if (!anchor || !view.dom.contains(anchor)) return false;

  const href = normalizeSafeLinkHref(anchor.getAttribute('href'));
  if (!href) {
    mouseEvent.preventDefault();
    return false;
  }

  if (mouseEvent.button !== 0) return false;
  if (!(isMac ? mouseEvent.metaKey : mouseEvent.ctrlKey)) return false;
  mouseEvent.preventDefault();
  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

type TabContext = 'list' | 'text' | 'other';
/**
 * Classify what `Tab` should mean at the cursor.
 *
 * `other` covers contexts that own the key themselves — table cells navigate
 * between cells, code blocks and math indent their source — so those must fall
 * through to their own handlers instead of being treated as an indent.
 */
function tabContext(state: EditorState): TabContext {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name.startsWith('table')) return 'other';
    if (name === 'list_item') return 'list';
  }
  const parent = $from.parent.type.name;
  return parent === 'paragraph' || parent === 'heading' ? 'text' : 'other';
}

/**
 * The top-level list immediately above the cursor's block, if any. Indenting a
 * paragraph joins that list rather than starting a second one next to it.
 */
function precedingTopLevelList(state: EditorState): ProseNode | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const previous = state.doc.resolve($from.before(1)).nodeBefore;
  if (!previous) return null;
  const name = previous.type.name;
  return name === 'bullet_list' || name === 'ordered_list' ? previous : null;
}

/**
 * Merge the freshly wrapped single-item list into the identical list before it,
 * so the item can then sink into it. Also aligns the item's `listType` attr,
 * which `wrapInList` fills from the schema default — a Milkdown plugin renders
 * no marker at all when that attr disagrees with the parent list.
 */
function joinIndentedItemIntoPrecedingList(view: EditorView): void {
  const { $from } = view.state.selection;
  if ($from.depth < 1) return;
  const listPos = $from.before(1);
  if (!canJoin(view.state.doc, listPos)) return;
  const tr = view.state.tr.join(listPos);
  view.dispatch(tr);
}

/**
 * `Tab` — indent.
 *
 * Markdown has no syntax for an indented paragraph, so indentation is mapped
 * onto list nesting: inside a list the item sinks a level; a plain paragraph is
 * wrapped into a list first and then sunk under the item above it, which leaves
 * a top-level bullet when there is no such item. Each step runs against
 * `view.state` because the previous one has already been dispatched.
 *
 * The key is consumed whenever it refers to text so a stray `Tab` mid-edit can
 * never move focus out of the editor; `Escape` still closes the panel, which is
 * the keyboard exit path.
 */
function indentSelection(
  listItemType: NodeType,
  bulletListType: NodeType | null,
): Command {
  return (state, dispatch, view) => {
    if (sinkListItem(listItemType)(state, dispatch)) return true;
    const context = tabContext(state);
    if (context === 'other') return false;
    if (context === 'list') return true;
    if (!bulletListType || !view || !dispatch) return true;
    const preceding = precedingTopLevelList(state);
    const listType = preceding?.type ?? bulletListType;
    const itemAttrs = preceding
      ? {
          listType:
            preceding.type.name === 'ordered_list' ? 'ordered' : 'bullet',
        }
      : null;
    if (wrapInList(listType, itemAttrs)(view.state, view.dispatch)) {
      joinIndentedItemIntoPrecedingList(view);
      sinkListItem(listItemType)(view.state, view.dispatch);
    }
    return true;
  };
}

/**
 * `Shift-Tab` — outdent. Reverses {@link indentSelection} one level at a time:
 * a nested item becomes a sibling, and a top-level item becomes a paragraph
 * again.
 */
function outdentSelection(listItemType: NodeType): Command {
  return (state, dispatch) => {
    if (liftListItem(listItemType)(state, dispatch)) return true;
    return tabContext(state) !== 'other';
  };
}

/**
 * Build and start a Crepe-backed editor.
 *
 * The feature set is hand-picked to match what we ship in Huabu:
 *  - `ImageBlock` is disabled because it pulls Vue into the bundle.
 *  - `AI` and `TopBar` are disabled because we render our own chrome.
 *  - `Toolbar` and `LinkTooltip` are disabled because React owns
 *    editing chrome.
 *  - When `previewMode` is set, `Table` / `Cursor` are additionally disabled — see
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
    ariaLabel: initialAriaLabel,
    toolbarMode = 'huabu',
    previewMode = false,
    uploadImage,
    importImage,
  } = options;
  const resolveImageSrc = options.resolveImageSrc ?? ((src: string) => src);
  const useReactToolbar = !previewMode && toolbarMode === 'huabu';
  let ariaLabel = initialAriaLabel;

  // Normalize LaTeX-style math delimiters (`\[…\]`, `\(…\)`)
  // emitted by AI assistants into the `$$…$$` / `$…$` form that
  // `remark-math` understands. See `normalizeMathDelimiters` for the
  // safeguards (code blocks / inline code are skipped, unpaired
  // delimiters are left alone). Applied at every markdown-in boundary
  // so both initial mount and subsequent `setMarkdown` reconciles get
  // the same treatment.
  const crepe = new Crepe({
    root,
    defaultValue: normalizeMathDelimiters(initialMarkdown),
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.Toolbar]: false,
      // Hide Crepe edit-time popovers when React owns the toolbar, when
      // the editor is read-only, and in drag-only preview mode. BlockEdit
      // stays on so the drag handle is still rendered; the slash menu inside
      // BlockEdit is naturally suppressed in preview because input events
      // never reach the editor (see `MilkdownPreview` capture handlers).
      //
      // `Cursor` is also disabled in preview mode: it injects a
      // permanent `<div class="crepe-drop-cursor milkdown-drop-indicator">`
      // sibling next to every editor root to render the drop bar, plus
      // a virtual caret plugin. Preview surfaces never accept drops and
      // never receive typing input, so both are dead weight — and with
      // N message cards in a long thread we'd otherwise leak N hidden
      // overlay divs into the DOM.
      ...(useReactToolbar || previewMode || !editable
        ? {
            [Crepe.Feature.LinkTooltip]: false,
          }
        : {}),
      ...(previewMode
        ? {
            [Crepe.Feature.Table]: false,
            [Crepe.Feature.Cursor]: false,
          }
        : {}),
    },
    featureConfigs: {
      ...(placeholder
        ? { [Crepe.Feature.Placeholder]: { text: placeholder } }
        : {}),
    },
  });

  // ProseMirror owns the textbox DOM and can replace it during Crepe's async
  // setup (notably across React StrictMode's setup/cleanup replay). Put the
  // accessible name in the EditorView props so every DOM instance is born
  // with it instead of patching whichever `.ProseMirror` happens to be
  // mounted at one point in time.
  crepe.editor.config((ctx) => {
    ctx.update(editorViewOptionsCtx, (viewOptions) => {
      const inheritedAttributes = viewOptions.attributes;
      return {
        ...viewOptions,
        attributes: (state) => ({
          ...(typeof inheritedAttributes === 'function'
            ? inheritedAttributes(state)
            : inheritedAttributes),
          ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        }),
      };
    });
  });

  // Markdown change listeners.
  //
  // We deliberately do NOT use `crepe.on(api => api.markdownUpdated(...))`.
  // The upstream `@milkdown/plugin-listener` debounces transaction-driven
  // serialization by 200ms; if the editor is destroyed within that window
  // (React StrictMode mount/unmount, rapid `setMarkdown` followed by
  // unmount, last keystroke before route change, etc.) the debounced
  // callback fires AFTER `ctx.remove(editorViewCtx)`. Crepe's
  // `paragraphSchema.toMarkdown.runner` reads `ctx.get(editorViewCtx)` to
  // detect the doc's last child (for empty-line preservation), so the
  // post-destroy serialize crashes with `Context "editorView" not found`.
  //
  // Instead we run the serializer synchronously inside a ProseMirror
  // plugin's `view.update`. By definition that fires while the editor
  // view is alive, so `editorViewCtx` is always set.
  const listeners = new Set<(markdown: string) => void>();
  const formattingListeners = new Set<
    (state: MilkdownFormattingState) => void
  >();
  crepe.editor
    .use(huabuColorSpanRemarkPlugin)
    .use(textColorMarkSchema)
    .use(backgroundColorMarkSchema);
  crepe.editor.use(
    $prose((ctx) => {
      const schema = ctx.get(schemaCtx);
      const listItemType = schema.nodes.list_item;
      if (!listItemType) return new Plugin({});
      return keymap({
        Tab: indentSelection(listItemType, schema.nodes.bullet_list ?? null),
        'Shift-Tab': outdentSelection(listItemType),
      });
    }),
  );
  crepe.editor.use(
    $prose(
      () =>
        new Plugin({
          props: {
            handleDOMEvents: {
              click: handleLinkClick,
              auxclick: handleLinkClick,
            },
          },
        }),
    ),
  );
  crepe.editor.use(
    $prose(
      (ctx) =>
        new Plugin({
          view: () => ({
            update: (view, prevState) => {
              if (formattingListeners.size > 0) {
                const activeMarks = new Set<MilkdownInlineMark>();
                for (const mark of Object.keys(
                  INLINE_MARK_NAMES,
                ) as MilkdownInlineMark[]) {
                  const type = getMarkType(ctx, INLINE_MARK_NAMES[mark]);
                  if (type && selectionHasMark(view.state, type)) {
                    activeMarks.add(mark);
                  }
                }
                const formattingState: MilkdownFormattingState = {
                  blockType: resolveBlockTypeKey(view.state) ?? 'paragraph',
                  activeMarks,
                  textColor: activeAccentToken(
                    view.state,
                    getMarkType(ctx, TEXT_COLOR_MARK_NAME),
                  ),
                  backgroundColor: activeAccentToken(
                    view.state,
                    getMarkType(ctx, BACKGROUND_COLOR_MARK_NAME),
                  ),
                };
                for (const listener of formattingListeners) {
                  listener(formattingState);
                }
              }

              if (listeners.size === 0) return;
              if (view.state.doc.eq(prevState.doc)) return;
              const serializer = ctx.get(serializerCtx);
              const markdown = serializer(view.state.doc);
              for (const listener of listeners) listener(markdown);
            },
          }),
        }),
    ),
  );

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

  // Phase 4: provenance decoration plugin.
  // We expose a single `setBlockDecorations` verb that dispatches a
  // meta-bearing transaction; the plugin recomputes its DecorationSet
  // from the doc + spec list. Block-keys (fingerprints) are computed
  // here against the LIVE doc so the spec stays trivially serializable
  // (just `{key, className}`).
  const decorationPluginKey = new PluginKey<{
    specs: ReadonlyArray<{ key: string; className: string }>;
    set: DecorationSet;
  }>('huabu-block-provenance');
  const META_KEY = 'huabu/setBlockDecorations';

  function buildDecorationSet(
    doc: ProseNode,
    specs: ReadonlyArray<{ key: string; className: string }>,
    serialize: (node: ProseNode) => string,
  ): DecorationSet {
    if (specs.length === 0) return DecorationSet.empty;
    const keys = blockKeysForDoc(doc, serialize);
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
      (ctx) =>
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
              // The serializer is only needed when there ARE specs to
              // place (meta set, or a doc change with live specs); an
              // empty spec list short-circuits inside `buildDecorationSet`
              // before touching it. It is always registered by the time a
              // decoration transaction runs.
              const serialize = (node: ProseNode): string =>
                ctx.get(serializerCtx)(node);
              if (meta !== undefined) {
                return {
                  specs: meta,
                  set: buildDecorationSet(tr.doc, meta, serialize),
                };
              }
              if (tr.docChanged) {
                return {
                  specs: value.specs,
                  set: buildDecorationSet(tr.doc, value.specs, serialize),
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

  // Image nodeView: resolve the stored `src` (bare artifact key or
  // legacy URL) to a fetchable URL for the rendered `<img>` ONLY. The
  // node attribute — and thus the serialized markdown / `onChange`
  // payload / block-provenance fingerprint — keeps the canonical bare
  // key untouched. This is why we resolve at the DOM boundary via a
  // nodeView rather than rewriting the markdown: rewriting would put
  // URLs into the live doc and desync the client's block fingerprints
  // from the server's (which are computed over the key-form markdown).
  crepe.editor.use(
    $prose(
      () =>
        new Plugin({
          props: {
            nodeViews: {
              image: (node) => {
                const dom = document.createElement('img');
                const applyAttrs = (n: ProseNode): void => {
                  dom.setAttribute(
                    'src',
                    resolveImageSrc(String(n.attrs.src ?? '')),
                  );
                  const alt = String(n.attrs.alt ?? '');
                  if (alt) dom.setAttribute('alt', alt);
                  else dom.removeAttribute('alt');
                  const title = String(n.attrs.title ?? '');
                  if (title) dom.setAttribute('title', title);
                  else dom.removeAttribute('title');
                };
                applyAttrs(node);
                return {
                  dom,
                  update: (updated: ProseNode) => {
                    if (updated.type.name !== 'image') return false;
                    applyAttrs(updated);
                    return true;
                  },
                };
              },
            },
          },
        }),
    ),
  );

  // Canvas-node clipboard paste. Canvas copy writes node metadata as
  // `text/plain`; without this handler ProseMirror inserts that JSON as text.
  // Only image-only selections are claimed (see the strict parser), while
  // ordinary text and mixed node selections retain the default paste path.
  if (importImage) {
    const importKey = new PluginKey<DecorationSet>('huabu-canvas-image-import');

    crepe.editor.use(
      $prose(
        () =>
          new Plugin<DecorationSet>({
            key: importKey,
            state: {
              init: () => DecorationSet.empty,
              apply: (tr, set) => {
                let next = set.map(tr.mapping, tr.doc);
                const meta = tr.getMeta(importKey) as
                  | { add?: Decoration; remove?: object }
                  | undefined;
                if (meta?.add) next = next.add(tr.doc, [meta.add]);
                if (meta?.remove) {
                  const id = meta.remove;
                  next = next.remove(
                    next.find(
                      undefined,
                      undefined,
                      (spec) => (spec as { id?: object }).id === id,
                    ),
                  );
                }
                return next;
              },
            },
            props: {
              decorations: (state) => importKey.getState(state),
              handleDOMEvents: {
                paste: (view, event) => {
                  const clipboardEvent = event as ClipboardEvent;
                  const clipboard = parseHuabuImageClipboard(
                    readHuabuClipboardPayload(clipboardEvent.clipboardData),
                  );
                  if (!clipboard) return false;

                  clipboardEvent.preventDefault();
                  void (async () => {
                    let anchor = view.state.selection.from;
                    for (const image of clipboard.images) {
                      const id = {};
                      const widget = document.createElement('span');
                      widget.className = 'milkdown-image-uploading';
                      widget.textContent = 'Importing image…';
                      const decoration = Decoration.widget(anchor, widget, {
                        id,
                      });
                      view.dispatch(
                        view.state.tr.setMeta(importKey, { add: decoration }),
                      );

                      try {
                        const src = await importImage({
                          src: image.src,
                          ...(clipboard.srcCanvasId
                            ? { srcCanvasId: clipboard.srcCanvasId }
                            : {}),
                        });
                        const set = importKey.getState(view.state);
                        const placeholder = set?.find(
                          undefined,
                          undefined,
                          (spec) => (spec as { id?: object }).id === id,
                        )[0];
                        const pos = placeholder?.from ?? anchor;
                        const imageType = view.state.schema.nodes.image;
                        const tr = view.state.tr.setMeta(importKey, {
                          remove: id,
                        });
                        if (imageType) {
                          const node = imageType.create({
                            src,
                            alt: image.label ?? '',
                          });
                          tr.insert(pos, node);
                          anchor = pos + node.nodeSize;
                        }
                        view.dispatch(tr.scrollIntoView());
                      } catch (err) {
                        view.dispatch(
                          view.state.tr.setMeta(importKey, { remove: id }),
                        );
                        toast('Failed to paste image', { tone: 'danger' });
                        console.error(
                          '[milkdown] canvas image import failed',
                          err,
                        );
                      }
                    }
                  })();
                  return true;
                },
              },
            },
          }),
      ),
    );
  }

  // Paste / drop image upload. Only wired when an `uploadImage` uploader
  // is supplied (editable note surfaces). Pasted or dropped image files
  // are intercepted BEFORE the browser inserts an ephemeral `blob:` URL,
  // uploaded to the canvas artifact store, and re-inserted as an `image`
  // node carrying the returned bare artifact key (which the nodeView
  // above resolves for display). An "uploading" placeholder widget marks
  // the insertion point while the async upload is in flight; its position
  // is tracked through concurrent edits by mapping the decoration set.
  if (uploadImage) {
    const doUpload = uploadImage;
    const uploadKey = new PluginKey<DecorationSet>('huabu-image-upload');

    const findPlaceholderPos = (
      state: EditorState,
      id: object,
    ): number | null => {
      const set = uploadKey.getState(state);
      if (!set) return null;
      const found = set.find(
        undefined,
        undefined,
        (spec) => (spec as { id?: object }).id === id,
      );
      return found.length > 0 ? found[0].from : null;
    };

    const runUploads = async (
      view: EditorView,
      files: File[],
      startPos: number,
    ): Promise<void> => {
      let anchor = startPos;
      for (const file of files) {
        const id = {};
        const widget = document.createElement('span');
        widget.className = 'milkdown-image-uploading';
        widget.textContent = 'Uploading image…';
        const deco = Decoration.widget(anchor, widget, { id });
        view.dispatch(view.state.tr.setMeta(uploadKey, { add: deco }));
        try {
          const key = await doUpload(file);
          const imageType = view.state.schema.nodes.image;
          const pos = findPlaceholderPos(view.state, id) ?? anchor;
          const tr = view.state.tr.setMeta(uploadKey, { remove: id });
          if (imageType) {
            const node = imageType.create({
              src: key,
              alt: fileNameToAlt(file.name),
            });
            tr.insert(pos, node);
            anchor = pos + node.nodeSize;
          }
          view.dispatch(tr.scrollIntoView());
        } catch (err) {
          view.dispatch(view.state.tr.setMeta(uploadKey, { remove: id }));
          toast('Failed to upload image', { tone: 'danger' });
          console.error('[milkdown] image upload failed', err);
        }
      }
    };

    crepe.editor.use(
      $prose(
        () =>
          new Plugin<DecorationSet>({
            key: uploadKey,
            state: {
              init: () => DecorationSet.empty,
              apply: (tr, set) => {
                let next = set.map(tr.mapping, tr.doc);
                const meta = tr.getMeta(uploadKey) as
                  | { add?: Decoration; remove?: object }
                  | undefined;
                if (meta?.add) {
                  next = next.add(tr.doc, [meta.add]);
                } else if (meta?.remove) {
                  const id = meta.remove;
                  next = next.remove(
                    next.find(
                      undefined,
                      undefined,
                      (spec) => (spec as { id?: object }).id === id,
                    ),
                  );
                }
                return next;
              },
            },
            props: {
              decorations: (state) => uploadKey.getState(state),
              handlePaste: (view, event) => {
                const files = extractImageFiles(event.clipboardData);
                if (files.length === 0) return false;
                event.preventDefault();
                void runUploads(view, files, view.state.selection.from);
                return true;
              },
              handleDrop: (view, event) => {
                const files = extractImageFiles(event.dataTransfer);
                if (files.length === 0) return false;
                event.preventDefault();
                const coords = view.posAtCoords({
                  left: event.clientX,
                  top: event.clientY,
                });
                const pos = coords ? coords.pos : view.state.selection.from;
                void runUploads(view, files, pos);
                return true;
              },
            },
          }),
      ),
    );

    // Blob-image catch-all. Some paste sources (e.g. copying an <img>
    // element off a web page) put ONLY an HTML `<img src="blob:…">`
    // reference on the clipboard — no image bytes in `files` / `items`
    // — so `handlePaste` above cannot intercept them and the browser's
    // default inserts an ephemeral object-URL image that would be
    // persisted verbatim and die on the next reload / port change.
    // This plugin watches for any `blob:` image node that lands in the
    // doc, fetches its bytes (the object URL is same-origin and still
    // live within the session), uploads it, and rewrites the node's
    // `src` to the returned bare artifact key.
    const handledBlobs = new Set<string>();

    const replaceBlobImage = async (
      view: EditorView,
      blobUrl: string,
    ): Promise<void> => {
      handledBlobs.add(blobUrl);
      try {
        const res = await fetch(blobUrl);
        const blob = await res.blob();
        const ext = (blob.type.split('/')[1] || 'png').split('+')[0];
        const file = new File([blob], `pasted.${ext}`, {
          type: blob.type || 'image/png',
        });
        const key = await doUpload(file);
        const { state } = view;
        const tr = state.tr;
        let changed = false;
        state.doc.descendants((node, pos) => {
          if (
            node.type.name === 'image' &&
            String(node.attrs.src ?? '') === blobUrl
          ) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: key });
            changed = true;
          }
        });
        if (changed) view.dispatch(tr);
      } catch (err) {
        // Keep the blob in `handledBlobs` so we don't spin retrying a
        // permanently-dead object URL every doc update.
        toast('Failed to upload pasted image', { tone: 'danger' });
        console.error('[milkdown] blob image upload failed', err);
      }
    };

    crepe.editor.use(
      $prose(
        () =>
          new Plugin({
            view: () => ({
              update: (view, prevState) => {
                if (view.state.doc.eq(prevState.doc)) return;
                const pending = new Set<string>();
                view.state.doc.descendants((node) => {
                  if (node.type.name !== 'image') return;
                  const src = String(node.attrs.src ?? '');
                  if (src.startsWith('blob:') && !handledBlobs.has(src)) {
                    pending.add(src);
                  }
                });
                for (const blobUrl of pending) {
                  void replaceBlobImage(view, blobUrl);
                }
              },
            }),
          }),
      ),
    );
  }

  await crepe.create();
  // Milkdown renders viewport coordinates into a fixed-position element.
  // Keep it outside transformed panel ancestors so those coordinates retain
  // their viewport reference frame (notably in split Preview Workspace).
  crepe.editor.action((ctx) => {
    const parent = ctx.get(editorViewCtx).dom.parentElement;
    const indicator = Array.from(parent?.children ?? []).find((child) =>
      child.classList.contains('milkdown-drop-indicator'),
    );
    if (indicator) document.body.appendChild(indicator);
  });
  crepe.setReadonly(!editable);

  return {
    getMarkdown: () => crepe.getMarkdown(),
    setMarkdown: (markdown: string) => {
      crepe.editor.action(replaceAll(normalizeMathDelimiters(markdown)));
    },
    setReadonly: (readonly: boolean) => {
      crepe.setReadonly(readonly);
    },
    setAriaLabel: (label: string) => {
      ariaLabel = label;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        // Re-applying the declarative attributes prop makes ProseMirror
        // recompute its outer decoration from the updated closure value.
        view.setProps({ attributes: view.props.attributes });
      });
    },
    getFormattingState: () => {
      let result: MilkdownFormattingState = {
        blockType: 'paragraph',
        activeMarks: new Set(),
        textColor: null,
        backgroundColor: null,
      };
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const activeMarks = new Set<MilkdownInlineMark>();
        for (const mark of Object.keys(
          INLINE_MARK_NAMES,
        ) as MilkdownInlineMark[]) {
          const type = getMarkType(ctx, INLINE_MARK_NAMES[mark]);
          if (type && selectionHasMark(view.state, type)) activeMarks.add(mark);
        }
        result = {
          blockType: resolveBlockTypeKey(view.state) ?? 'paragraph',
          activeMarks,
          textColor: activeAccentToken(
            view.state,
            getMarkType(ctx, TEXT_COLOR_MARK_NAME),
          ),
          backgroundColor: activeAccentToken(
            view.state,
            getMarkType(ctx, BACKGROUND_COLOR_MARK_NAME),
          ),
        };
      });
      return result;
    },
    getSelectionClientRect: () => {
      let result: DOMRect | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { selection } = view.state;
        if (selection.empty) return;

        if (selection instanceof NodeSelection) {
          const selectedDom = view.nodeDOM(selection.from);
          const element =
            selectedDom instanceof Element
              ? selectedDom
              : selectedDom?.parentElement;
          if (element && view.dom.contains(element)) {
            const rect = element.getBoundingClientRect();
            result = new DOMRect(rect.x, rect.y, rect.width, rect.height);
            return;
          }
        }

        const nativeSelection = view.dom.ownerDocument.getSelection();
        if (nativeSelection && nativeSelection.rangeCount > 0) {
          const range = nativeSelection.getRangeAt(0);
          const container = range.commonAncestorContainer;
          const element =
            container instanceof Element ? container : container.parentElement;
          if (element && view.dom.contains(element)) {
            const rect = range.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0) {
              result = new DOMRect(rect.x, rect.y, rect.width, rect.height);
              return;
            }
          }
        }

        const start = view.coordsAtPos(selection.from);
        const end = view.coordsAtPos(selection.to);
        const left = Math.min(start.left, end.left);
        const top = Math.min(start.top, end.top);
        const right = Math.max(start.right, end.right);
        const bottom = Math.max(start.bottom, end.bottom);
        result = new DOMRect(left, top, right - left, bottom - top);
      });
      return result;
    },
    getSelectionRange: (includeEmpty = false) => {
      let result: MilkdownTextRange | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { selection } = view.state;
        if (
          (!includeEmpty && selection.empty) ||
          selection instanceof NodeSelection
        ) {
          return;
        }
        result = { from: selection.from, to: selection.to };
      });
      return result;
    },
    getSelectionText: () => {
      let result: string | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { selection, doc } = view.state;
        if (selection.empty || selection instanceof NodeSelection) return;
        result = doc.textBetween(selection.from, selection.to, ' ');
      });
      return result;
    },
    getActiveLink: () => {
      let result: MilkdownLinkState | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const linkType = getMarkType(ctx, 'link');
        if (!linkType) return;
        const range = markRangeAt(view.state, linkType);
        if (!range) return;
        const href = range.attrs.href;
        if (typeof href === 'string') {
          result = { href, range: { from: range.from, to: range.to } };
        }
      });
      return result;
    },
    getActiveInlineMath: () => {
      let result: MilkdownInlineMathState | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        result = inlineMathRangeAt(view.state);
      });
      return result;
    },
    onFormattingUpdated: (listener) => {
      formattingListeners.add(listener);
      return () => {
        formattingListeners.delete(listener);
      };
    },
    __selectCurrentBlockForTest: () => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const range = currentTopLevelBlockRange(view.state);
        if (!range) return;
        view.dispatch(
          view.state.tr.setSelection(
            NodeSelection.create(view.state.doc, range.from),
          ),
        );
      });
    },
    __selectAllTextForTest: () => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const from = 1;
        const to = Math.max(from, view.state.doc.content.size - 1);
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, from, to),
          ),
        );
      });
    },
    __selectTextBetweenForTest: (fromText, toText) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let from: number | null = null;
        let to: number | null = null;
        view.state.doc.descendants((node, pos) => {
          // Both endpoints are the FIRST match, and `toText` is only
          // searched at or after `from`, so the range always runs
          // forwards regardless of how often either string repeats.
          if (to !== null) return false;
          if (!node.isText) return true;
          const value = node.text ?? '';
          if (from === null) {
            const index = value.indexOf(fromText);
            if (index !== -1) from = pos + index;
          }
          if (from === null) return true;
          const index = value.indexOf(toText, Math.max(0, from - pos));
          if (index !== -1) to = pos + index + toText.length;
          return true;
        });
        if (from === null || to === null || from >= to) return;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, from, to),
          ),
        );
      });
    },
    __getDraggingMarkdownForTest: () => {
      let result: string | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const dragging = view.dragging;
        if (!dragging) return;
        const serializer = ctx.get(serializerCtx);
        const docNode = view.state.schema.topNodeType.create(
          null,
          dragging.slice.content,
        );
        result = serializer(docNode);
      });
      return result;
    },
    __setCursorAfterTextForTest: (text) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let cursorPos: number | null = null;
        view.state.doc.descendants((node, pos) => {
          if (cursorPos !== null) return false;
          if (!node.isText) return true;
          const value = node.text ?? '';
          const index = value.indexOf(text);
          if (index === -1) return true;
          cursorPos = pos + index + text.length;
          return false;
        });
        if (cursorPos === null) return;
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(view.state.doc, cursorPos))
            .scrollIntoView(),
        );
        view.focus();
      });
    },
    __selectListItemContainingTextForTest: (text) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let listItemPos: number | null = null;
        view.state.doc.descendants((node, pos) => {
          if (listItemPos !== null) return false;
          if (!node.isText) return true;
          const value = node.text ?? '';
          if (!value.includes(text)) return true;
          const $resolved = view.state.doc.resolve(pos + 1);
          for (let depth = $resolved.depth; depth > 0; depth--) {
            if ($resolved.node(depth).type.name !== 'list_item') continue;
            listItemPos = $resolved.before(depth);
            return false;
          }
          return true;
        });
        if (listItemPos === null) return;
        view.dispatch(
          view.state.tr.setSelection(
            NodeSelection.create(view.state.doc, listItemPos),
          ),
        );
        view.focus();
      });
    },
    __selectListItemAsRangeForTest: (text) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let itemFrom: number | null = null;
        let itemTo: number | null = null;
        view.state.doc.descendants((node, pos) => {
          if (itemFrom !== null) return false;
          if (!node.isText) return true;
          const value = node.text ?? '';
          if (!value.includes(text)) return true;
          const $resolved = view.state.doc.resolve(pos + 1);
          for (let depth = $resolved.depth; depth > 0; depth--) {
            if ($resolved.node(depth).type.name !== 'list_item') continue;
            itemFrom = $resolved.before(depth);
            itemTo = $resolved.after(depth);
            return false;
          }
          return true;
        });
        if (itemFrom === null || itemTo === null) return;
        // Mimic Crepe's block handle: a TextSelection spanning the item at
        // the enclosing list level (its `$from` resolves to the list node).
        view.dispatch(
          view.state.tr
            .setSelection(
              TextSelection.create(view.state.doc, itemFrom, itemTo),
            )
            .scrollIntoView(),
        );
        view.focus();
      });
    },
    __dispatchKeyDownForTest: (key, shiftKey = false) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dom.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            shiftKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
    toggleMark: (mark) => {
      crepe.editor.action((ctx) => {
        const type = getMarkType(ctx, INLINE_MARK_NAMES[mark]);
        if (!type) return;
        runCommand(ctx, toggleMark(type));
      });
    },
    setBlockType: (type) => {
      crepe.editor.action((ctx) => runBlockTypeCommand(ctx, type));
    },
    setTextColor: (color) => {
      crepe.editor.action((ctx) => {
        setAccentColorMark(ctx, TEXT_COLOR_MARK_NAME, color, 'text');
      });
    },
    setBackgroundColor: (color) => {
      crepe.editor.action((ctx) => {
        setAccentColorMark(
          ctx,
          BACKGROUND_COLOR_MARK_NAME,
          color,
          'background',
        );
      });
    },
    setLink: (href, range) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const linkType = getMarkType(ctx, 'link');
        if (!linkType) return;
        const { state } = view;
        const liveSelection = state.selection;
        const selectionRange =
          !liveSelection.empty && !(liveSelection instanceof NodeSelection)
            ? { from: liveSelection.from, to: liveSelection.to }
            : null;
        const targetRange = range ?? selectionRange;

        const nextHref = normalizeSafeLinkHref(href);
        if (!targetRange || targetRange.from >= targetRange.to) {
          if (nextHref) {
            const mark = linkType.create({ href: nextHref });
            const node = state.schema.text(nextHref, [mark]);
            const tr = state.tr;
            if (liveSelection instanceof NodeSelection) {
              const insertionPos = textInsertionPosForNodeSelection(
                state,
                liveSelection,
              );
              if (insertionPos !== null) {
                tr.setSelection(TextSelection.create(state.doc, insertionPos));
              }
            }
            view.dispatch(
              tr.replaceSelectionWith(node, false).scrollIntoView(),
            );
          }
          view.focus();
          return;
        }

        const from = Math.max(
          0,
          Math.min(targetRange.from, state.doc.content.size),
        );
        const to = Math.max(
          from,
          Math.min(targetRange.to, state.doc.content.size),
        );
        const tr = state.tr.removeMark(from, to, linkType);
        if (!nextHref) {
          view.dispatch(tr.scrollIntoView());
          view.focus();
          return;
        }

        view.dispatch(
          tr
            .addMark(from, to, linkType.create({ href: nextHref }))
            .scrollIntoView(),
        );
        view.focus();
      });
    },
    insertInlineMath: () => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const { from, to, empty } = state.selection;
        const mathInlineType = getNodeType(ctx, 'math_inline');
        if (!mathInlineType) return;

        const value = empty ? 'x' : state.doc.textBetween(from, to, ' ');
        const node = mathInlineType.create({ value });
        const tr = state.tr.replaceSelectionWith(node, false);
        if (empty) {
          tr.setSelection(NodeSelection.create(tr.doc, from));
        }
        view.dispatch(tr.scrollIntoView());
        view.focus();
      });
    },
    setInlineMath: (value, range) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const mathInlineType = getNodeType(ctx, 'math_inline');
        if (!mathInlineType) return;

        const { state } = view;
        const nextValue = value.trim() || 'x';
        const activeMath = inlineMathRangeAt(state);
        const targetRange = range ?? activeMath?.range ?? null;
        const node = mathInlineType.create({ value: nextValue });

        if (targetRange && targetRange.from < targetRange.to) {
          const from = Math.max(
            0,
            Math.min(targetRange.from, state.doc.content.size),
          );
          const to = Math.max(
            from,
            Math.min(targetRange.to, state.doc.content.size),
          );
          const tr = state.tr.replaceWith(from, to, node);
          tr.setSelection(NodeSelection.create(tr.doc, from));
          view.dispatch(tr.scrollIntoView());
          view.focus();
          return;
        }

        const tr = state.tr.replaceSelectionWith(node, false);
        tr.setSelection(NodeSelection.create(tr.doc, state.selection.from));
        view.dispatch(tr.scrollIntoView());
        view.focus();
      });
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
    setDragSelection: (range) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const from = Math.max(
          0,
          Math.min(range.from, view.state.doc.content.size),
        );
        const to = Math.max(
          from,
          Math.min(range.to, view.state.doc.content.size),
        );
        // The endpoints sit BETWEEN blocks rather than inside a
        // textblock, which ProseMirror tolerates (one `console.warn`)
        // but never normalizes. That is deliberate: the drop handler
        // removes the source through `tr.deleteSelection()`, so the
        // selection has to span whole blocks or the move would leave
        // empty shells behind.
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, from, to),
          ),
        );
      });
    },
    setDraggingSlice: (range) => {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const from = Math.max(
          0,
          Math.min(range.from, view.state.doc.content.size),
        );
        const to = Math.max(
          from,
          Math.min(range.to, view.state.doc.content.size),
        );
        view.dragging = {
          slice: view.state.doc.slice(from, to),
          move: true,
        };
      });
    },
    clearDraggingSlice: () => {
      crepe.editor.action((ctx) => {
        ctx.get(editorViewCtx).dragging = null;
      });
    },
    getDragRangeAtDOM: (target) => {
      let result: MilkdownDragRange | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (!view.dom.contains(target)) return;

        let pos: number;
        try {
          pos = view.posAtDOM(target, 0);
        } catch {
          return;
        }

        const resolved = view.state.doc.resolve(
          Math.max(0, Math.min(pos, view.state.doc.content.size)),
        );
        const depth = findDragBlockDepth(resolved);
        if (depth === null) return;

        result = {
          from: resolved.before(depth),
          to: resolved.after(depth),
        };
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

          result = { markdown, blockElements, range };
          return;
        }

        // Single-block path: rely on the `NodeSelection` that Crepe's
        // block handle dispatched on mousedown.
        const selection = view.state.selection;
        if (!(selection instanceof NodeSelection)) return;

        const node = selection.node;
        // A `list_item` can't be a direct child of `doc` (schema-
        // invalid), so `doc > list_item` serializes to an empty
        // string — `getDragPayload` then returns `null` and the whole
        // drag silently carries no Huabu payload (bullet items
        // become un-droppable everywhere). Wrap the item in a copy of
        // its parent list (`bullet_list` / `ordered_list`) so the
        // serializer sees a well-formed `<list> > <list_item>`.
        let contentNode = node;
        if (node.type.name === 'list_item') {
          const listParent = selection.$from.parent;
          if (listParent && LIST_NODE_NAMES.has(listParent.type.name)) {
            contentNode = listParent.type.create(listParent.attrs, node);
          }
        }
        const docNode = view.state.schema.topNodeType.create(null, contentNode);
        const markdown = serializer(docNode);
        if (!markdown.trim()) return;

        const domAtPos = view.nodeDOM(selection.from);
        const element =
          domAtPos instanceof HTMLElement
            ? domAtPos
            : (view.dom as HTMLElement);

        result = {
          markdown,
          blockElements: [element],
          range: { from: selection.from, to: selection.to },
        };
      });
      return result;
    },

    getDocAfterRangeRemoved: (range) => {
      let result: string | null = null;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const serializer = ctx.get(serializerCtx);
        const doc = view.state.doc;

        if (!range || range.from >= range.to) {
          result = serializer(doc);
          return;
        }

        // Build the post-delete doc off an undispatched transaction;
        // the live editor state stays untouched.
        const tr = view.state.tr.delete(range.from, range.to);
        result = serializer(tr.doc);
      });
      return result ?? '';
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
        const snap = buildSnapshotFromView(view, ctx.get(serializerCtx));
        const idx = snap.keys.indexOf(key);
        if (idx === -1) return;
        const from = snap.posByIndex[idx];
        const to = from + view.state.doc.child(idx).nodeSize;
        const parsed = parser(dedentMarkdownFragment(markdown));
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
        const snap = buildSnapshotFromView(view, ctx.get(serializerCtx));
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
        const parsed = parser(dedentMarkdownFragment(markdown));
        if (!parsed) return;

        let pos = 0;
        if (anchorKey !== null) {
          const snap = buildSnapshotFromView(view, ctx.get(serializerCtx));
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

    insertBlocksAtDropIndicator: (markdown) => {
      let ok = false;
      crepe.editor.action((ctx) => {
        let indicator: { pos: number } | null = null;
        try {
          indicator = ctx.get(dropIndicatorState.key);
        } catch {
          return; // Cursor feature not registered on this surface.
        }
        if (!indicator) return;
        const view = ctx.get(editorViewCtx);
        const parsed = ctx.get(parserCtx)(dedentMarkdownFragment(markdown));
        if (!parsed || parsed.content.size === 0) return;
        // `replaceRange`, not `insert`: the indicator can point between
        // two list items, where a bare paragraph is not a legal child.
        // `replaceRange` wraps the content to fit, the same way the
        // indicator plugin handles its own native drops.
        const tr = view.state.tr.replaceRange(
          indicator.pos,
          indicator.pos,
          new Slice(parsed.content, 0, 0),
        );
        if (tr.doc.eq(view.state.doc)) return;
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

    clearDropIndicator: () => {
      // `prosemirror-drop-indicator` listens for `dragend` directly on
      // `view.dom`. Dispatching a synthetic one is the only
      // public-API-friendly way to flush it when the real `dragend`
      // lands on a drag source outside this editor (cross-source
      // drops). The handler doesn't read any dataTransfer fields, so a
      // plain `Event` is enough — no need to construct a full
      // `DragEvent` (which would require a `DataTransfer` instance
      // that isn't constructable in Safari).
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          view.dom.dispatchEvent(new Event('dragend', { bubbles: false }));
        });
      } catch {
        // Editor already destroyed — nothing to clear.
      }
    },

    focus: () => {
      // Wrap in try/catch: the editor may have been destroyed between
      // the caller scheduling the focus and this action running
      // (e.g. the host panel unmounted in the same tick).
      try {
        crepe.editor.action((ctx) => {
          ctx.get(editorViewCtx).focus();
        });
      } catch {
        // View already torn down — nothing to focus.
      }
    },

    destroy: async () => {
      listeners.clear();
      // Neutralise the EditorView's `dispatch` BEFORE we tear Crepe
      // down. Crepe internals schedule transactions through several
      // async paths (tooltip providers' debounced shouldShow that may
      // commit selection-driven state, the latex inner NodeView's
      // `requestAnimationFrame(() => view.focus())` after dispatching
      // a node-update, the virtual cursor plugin, etc.). Any of those
      // callbacks firing AFTER `crepe.destroy()` has begun removing
      // ctx slices crashes inside the `MILKDOWN_STATE_TRACKER` plugin
      // with `Context "editorState" not found`, because the plugin's
      // `apply` does `ctx.set(editorStateCtx, ...)` on a slice that
      // was already removed. By overwriting `dispatch` with a no-op
      // first, we drop those late transactions silently — the editor
      // is going away so the work is irrelevant anyway.
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          (view as { dispatch: (...args: unknown[]) => void }).dispatch =
            () => {};
        });
      } catch {
        // The editor may already be in a partially torn-down state
        // (e.g. another caller invoked destroy concurrently). Nothing
        // to neutralise — proceed to crepe.destroy().
      }
      await crepe.destroy();
    },
  };

  /**
   * Internal: walk every top-level block once and produce both the
   * fingerprint keys and a position index. Used by every Phase 4
   * helper. Returns the structural data without serializer/DOM —
   * those are layered on by `buildBlockSnapshot` for public callers.
   */
  function buildSnapshotFromView(
    view: EditorView,
    serialize: (node: ProseNode) => string,
  ): {
    keys: string[];
    posByIndex: number[];
  } {
    const posByIndex: number[] = [];
    let pos = 0;
    view.state.doc.forEach((node) => {
      posByIndex.push(pos);
      pos += node.nodeSize;
    });
    return { keys: blockKeysForDoc(view.state.doc, serialize), posByIndex };
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
      const snap = buildSnapshotFromView(view, serializer);
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
