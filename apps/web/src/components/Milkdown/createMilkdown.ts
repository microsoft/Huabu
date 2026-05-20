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

import { editorViewCtx, serializerCtx } from '@milkdown/core';
import { Crepe } from '@milkdown/crepe';
import { blockConfig } from '@milkdown/plugin-block';
import { findParent } from '@milkdown/prose';
import { NodeSelection } from '@milkdown/prose/state';
import { replaceAll } from '@milkdown/utils';

import type { ResolvedPos } from '@milkdown/prose/model';

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
    featureConfigs: placeholder
      ? {
          [Crepe.Feature.Placeholder]: { text: placeholder },
        }
      : undefined,
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
    destroy: async () => {
      listeners.clear();
      await crepe.destroy();
    },
  };
}
