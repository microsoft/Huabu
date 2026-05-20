/**
 * Read-only Milkdown surface, optionally isolated in a Shadow DOM.
 *
 * Used wherever we previously rendered `BlockNoteCard` (chat messages,
 * AI previews). The Shadow DOM isolation matches the BlockNote pattern:
 * it keeps Milkdown's CSS from leaking into the surrounding page (and
 * vice-versa) without giving up document-level styles, thanks to
 * `applySharedStyles`.
 *
 * When `enableBlockDrag` is set, the editor is mounted as editable so
 * Crepe's block handle is available, but all input mutations are
 * suppressed via DOM capture handlers (same approach as the legacy
 * BlockNoteCard). The `previewMode` option additionally disables the
 * floating Toolbar / LinkTooltip / Table chrome so the surface looks
 * genuinely read-only without resorting to CSS hacks.
 *
 * Multi-block drag parity with the legacy BlockNoteCard works in two
 * stages: a capture-phase `mousedown` snapshots the current text
 * selection (before Crepe's bubble-phase handler clobbers it with a
 * single-block `NodeSelection`); the bubbling `dragstart` then resolves
 * the drag payload from that snapshot and builds a unified drag image
 * (the same builder serves both single- and multi-block drags so they
 * look identical to the user).
 */

import { useCallback, useEffect, useRef } from 'react';

import { applySharedStyles } from '@/utils/shadowStyleCache';

import {
  createMilkdown,
  type MilkdownDragRange,
  type MilkdownInstance,
} from './createMilkdown';
import { markdownEquals, normalizeMarkdown } from './markdownUtils';

import type { MilkdownBlockDragEvent } from './types';

export interface MilkdownPreviewProps {
  markdown: string;
  /** Render inside a Shadow DOM. Default `true` for style isolation. */
  isolate?: boolean;
  className?: string;
  /**
   * Show Crepe's block drag handle and call `onBlockDragStart` when the
   * user starts dragging a block out of the editor. Default `false`.
   */
  enableBlockDrag?: boolean;
  /** Fires alongside Crepe's native drag handler when a block drag begins. */
  onBlockDragStart?: (event: MilkdownBlockDragEvent) => void;
}

/** Keys that we still want to bubble even in drag-only readonly mode. */
const NAV_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
  'Tab',
]);

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

function shouldSwallowKey(e: React.KeyboardEvent): boolean {
  if (MODIFIER_KEYS.has(e.key) || NAV_KEYS.has(e.key)) return false;
  const key = e.key.toLowerCase();
  // Preserve copy / select-all so the user can still pull text out.
  const isCopyOrSelectAll =
    (e.ctrlKey || e.metaKey) && (key === 'c' || key === 'a');
  if (isCopyOrSelectAll) return false;
  return true;
}

/**
 * Build a drag preview that visually matches the live editor — used
 * for BOTH single-block and multi-block drags so the two paths look
 * identical (a single-block preview is just an N=1 case of the same
 * builder).
 *
 * Three correctness requirements drive the design:
 *
 *  1. **`setDragImage` must actually render it.** Chrome's drag-image
 *     rasterizer has long-standing quirks with elements that live
 *     inside a Shadow DOM (the snapshot can come out empty even when
 *     the element is otherwise correctly rendered). We therefore mount
 *     the preview in `document.body` (light DOM).
 *
 *  2. **Editor styling must apply.** Crepe's theme, our
 *     `milkdown-overrides.css`, and the KaTeX stylesheet are all
 *     imported by `createMilkdown.ts` and end up in `document.head`
 *     via Vite, so any element in `document.body` can pick them up —
 *     PROVIDED the selectors' ancestor chain is satisfied. The
 *     overrides are scoped under `.milkdown .ProseMirror …`, so we
 *     wrap the cloned blocks with that exact ancestor chain. Crepe's
 *     own list / heading / code rules are scoped the same way, so the
 *     single wrapper covers both.
 *
 *  3. **Parent context for list items.** A bare `<li>` cloned outside
 *     its `<ul>` / `<ol>` parent loses its list marker positioning
 *     (browsers anchor `::marker` against the list wrapper, and Crepe
 *     adds list-specific padding on the wrapper too). We therefore
 *     group consecutive `blockElements` that share an immediate
 *     `<ul>` / `<ol>` parent and shallow-clone that wrapper so the
 *     selected items render inside a real list. This also makes the
 *     single-list-item case render with its bullet, just like in the
 *     editor.
 *
 * The preview is positioned far off-screen (`top:-10000px`) so it does
 * not affect layout while still being rasterized — a `display:none`
 * element produces no visual snapshot for `setDragImage`, but an
 * off-screen positioned element does.
 *
 * The "lifted card" chrome (translucent surface, border, soft shadow)
 * is applied via the `.milkdown-drag-preview-host` rule in
 * `milkdown-overrides.css` — keep visual styling there, keep
 * positioning / structural styling here.
 *
 * Caller is responsible for removing the returned element after the
 * browser has snapshotted it.
 */
function buildBlockDragImage(
  blockElements: HTMLElement[],
  mountRoot: HTMLElement,
): HTMLElement {
  // Outer host: positions off-screen and matches the editor's content
  // width so line wrapping in the preview matches what the user saw.
  const host = document.createElement('div');
  host.className = 'milkdown-drag-preview-host';
  host.style.position = 'absolute';
  host.style.top = '-10000px';
  host.style.left = '-10000px';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const editorContentRoot = mountRoot.querySelector('.milkdown');
  const referenceWidth =
    editorContentRoot?.getBoundingClientRect().width ??
    blockElements[0]?.getBoundingClientRect().width;
  if (referenceWidth) host.style.width = `${referenceWidth}px`;

  // Reproduce the editor's ancestor chain so `.milkdown .ProseMirror …`
  // selectors from Crepe and our overrides match the cloned content.
  const milkdownLayer = document.createElement('div');
  milkdownLayer.className = 'milkdown';

  const proseLayer = document.createElement('div');
  proseLayer.className = 'ProseMirror';
  // Natural block flow — Crepe / overrides already supply the paragraph
  // and list margins via `.milkdown .ProseMirror …` selectors that our
  // wrapper now satisfies, so we don't need flex / gap here.

  milkdownLayer.appendChild(proseLayer);
  host.appendChild(milkdownLayer);

  const stripIds = (el: HTMLElement) => {
    el.removeAttribute('id');
    el.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  };

  // Walk the array, grouping consecutive blocks that share an
  // immediate parent. A "list group" gets a shallow-cloned list
  // wrapper; everything else is appended directly.
  let i = 0;
  while (i < blockElements.length) {
    const start = blockElements[i];
    const parent = start.parentElement;
    let end = i + 1;
    while (
      end < blockElements.length &&
      blockElements[end].parentElement === parent
    ) {
      end++;
    }
    const groupItems = blockElements.slice(i, end);

    const parentTag = parent?.tagName;
    if (parent && (parentTag === 'UL' || parentTag === 'OL')) {
      const wrapper = parent.cloneNode(false) as HTMLElement;
      stripIds(wrapper);
      for (const item of groupItems) {
        const clone = item.cloneNode(true) as HTMLElement;
        stripIds(clone);
        wrapper.appendChild(clone);
      }
      proseLayer.appendChild(wrapper);
    } else {
      for (const item of groupItems) {
        const clone = item.cloneNode(true) as HTMLElement;
        stripIds(clone);
        proseLayer.appendChild(clone);
      }
    }

    i = end;
  }

  document.body.appendChild(host);
  return host;
}

export function MilkdownPreview(props: MilkdownPreviewProps): JSX.Element {
  const {
    markdown,
    isolate = true,
    className,
    enableBlockDrag = false,
    onBlockDragStart,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<MilkdownInstance | null>(null);
  const lastSyncedRef = useRef<string>(normalizeMarkdown(markdown));
  const pendingMarkdownRef = useRef<string | null>(null);
  // Snapshot of the multi-block text selection captured at mousedown,
  // BEFORE Crepe's bubble-phase handler replaces it with a single-block
  // NodeSelection. Read by `dragstart` to decide whether to issue a
  // multi-block payload.
  const priorSelectionRef = useRef<MilkdownDragRange | null>(null);
  // Keep the latest drag callback in a ref so the mount effect stays
  // stable while still reading fresh closures.
  const onBlockDragStartRef = useRef(onBlockDragStart);
  onBlockDragStartRef.current = onBlockDragStart;

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // Resolve the mount node. With isolation we attach a fresh Shadow
    // DOM and let Milkdown live inside its own document-style scope.
    let mountRoot: HTMLElement;
    let createdShadow: ShadowRoot | null = null;
    if (isolate) {
      // attachShadow throws if a shadow root already exists. In React
      // StrictMode the first effect run may have created one already
      // (the cleanup keeps the host element). Guard with `shadowRoot`.
      const existing = container.shadowRoot;
      const shadow = existing ?? container.attachShadow({ mode: 'open' });
      if (!existing) createdShadow = shadow;
      // Clear any leftover children (e.g. from the previous mount)
      // BEFORE re-applying styles. `applySharedStyles` may append
      // fallback `<link>` elements for cross-origin stylesheets it
      // could not adopt via `adoptedStyleSheets`; clearing afterwards
      // would silently strip them.
      while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
      applySharedStyles(shadow);
      const inner = document.createElement('div');
      shadow.appendChild(inner);
      mountRoot = inner;
    } else {
      mountRoot = container;
    }

    // Class hook used by `milkdown-overrides.css` to scope the compact
    // block-handle (single 18px grip, no "+ add" button) to chat-card
    // previews only — the standalone editor keeps the full Crepe handle.
    if (enableBlockDrag) {
      mountRoot.classList.add('milkdown-preview-host');
    }

    // Capture-phase mousedown — fires BEFORE Crepe's BlockService
    // bubble-phase handler. When the user already has a multi-block
    // text selection and now mousedowns on the block handle, Crepe
    // would normally dispatch a single-block `NodeSelection`,
    // clobbering the multi-block range; its `dragstart` then
    // serializes only that single block.
    //
    // We defuse that in two steps:
    //   1. Snapshot the multi-block range so `dragstart` can serialize
    //      it explicitly (the source of truth even if PM's state was
    //      later mutated by someone else).
    //   2. `event.stopPropagation()` to PREVENT Crepe's mousedown from
    //      running at all. That leaves view.state.selection as the
    //      original multi-block TextSelection and Crepe's
    //      `#activeSelection` as null, so its `dragstart` writes no
    //      data — our bubble-phase handler owns the entire payload.
    //
    // For single-block drags (no multi-block range present) we DON'T
    // stop propagation: Crepe's mousedown is required to dispatch the
    // NodeSelection that `getDragPayload(null)` falls back to.
    //
    // Native HTML5 drag is started by the browser based on the
    // handle's `draggable="true"` attribute and does not depend on
    // Crepe's mousedown handler running, so the user-visible drag
    // begins normally either way.
    const mousedownCaptureHandler = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.milkdown-block-handle')) {
        priorSelectionRef.current = null;
        return;
      }
      const instance = instanceRef.current;
      const range = instance?.getMultiBlockSelectionRange() ?? null;
      priorSelectionRef.current = range;
      if (range) event.stopPropagation();
    };
    mountRoot.addEventListener('mousedown', mousedownCaptureHandler, {
      capture: true,
    });

    // Bubbling dragstart listener — fires AFTER Crepe's BlockService
    // handler (which is registered on the inner `.milkdown-block-handle`
    // wrapper). Crepe has already populated `dataTransfer` with
    // `text/html` / `text/plain` and set the drag image; we layer the
    // Sediment markdown payload through the user-supplied callback
    // and substitute a unified drag image that mirrors the editor's
    // exact styling for BOTH single- and multi-block drags.
    //
    // Why we own the drag image (and not the consumer that calls
    // `setDragPayload`): the preview needs the editor's CSS context
    // (`.milkdown .ProseMirror`) to render correctly, and only this
    // component knows where the live editor lives. Building it here
    // keeps the single- vs multi-block paths visually identical — the
    // multi-block case is just an N>1 instance of the same builder,
    // which removes a class of "my single-block drag looks different
    // from my multi-block drag" bugs.
    //
    // Calling `setDragImage` after Crepe overrides its earlier call
    // (HTML5 spec: the last `setDragImage` invocation during dragstart
    // wins).
    const dragHandler = (event: DragEvent) => {
      const callback = onBlockDragStartRef.current;
      const instance = instanceRef.current;
      if (!callback || !instance) return;

      const target = event.target as HTMLElement | null;
      const handle = target?.closest('.milkdown-block-handle');
      if (!handle) return;

      const snapshot = priorSelectionRef.current;
      // Clear immediately so a subsequent single-block drag isn't
      // accidentally treated as multi-block.
      priorSelectionRef.current = null;

      const payload = instance.getDragPayload(snapshot);
      if (!payload) return;

      const { markdown: dragMarkdown, blockElements } = payload;

      if (blockElements.length > 0 && event.dataTransfer) {
        const preview = buildBlockDragImage(blockElements, mountRoot);
        // Anchor the preview's top-left near the cursor; the block
        // handle sits just to the LEFT of a block, so (0, 0) reads as
        // "the content the user was about to drag is hugging their
        // cursor".
        event.dataTransfer.setDragImage(preview, 0, 0);
        // Keep the preview around long enough for the browser to
        // snapshot it, then tear it down on the next tick.
        window.setTimeout(() => preview.remove(), 0);
      }

      callback({
        markdown: dragMarkdown,
        nativeEvent: event,
      });
    };
    mountRoot.addEventListener('dragstart', dragHandler);

    // Defensive: clear the snapshot when the drag ends (or is
    // cancelled), so a stale range can't poison a future drag.
    const dragEndHandler = () => {
      priorSelectionRef.current = null;
    };
    mountRoot.addEventListener('dragend', dragEndHandler);

    void (async () => {
      const instance = await createMilkdown({
        root: mountRoot,
        initialMarkdown: lastSyncedRef.current,
        // When block drag is requested we need the editor in editable
        // mode so Crepe shows the block handle and lets the user
        // initiate a native drag. Input mutations are still blocked by
        // the wrapper's capture handlers below.
        editable: enableBlockDrag,
        // Disable Crepe's edit-time chrome (Toolbar / LinkTooltip /
        // Table reorder handles) when the surface is drag-only. See
        // `MilkdownFactoryOptions.previewMode`.
        previewMode: enableBlockDrag,
      });

      if (cancelled) {
        await instance.destroy();
        return;
      }

      instanceRef.current = instance;

      const pending = pendingMarkdownRef.current;
      pendingMarkdownRef.current = null;
      if (pending !== null && pending !== lastSyncedRef.current) {
        lastSyncedRef.current = pending;
        instance.setMarkdown(pending);
      }
    })();

    return () => {
      cancelled = true;
      mountRoot.removeEventListener('mousedown', mousedownCaptureHandler, {
        capture: true,
      });
      mountRoot.removeEventListener('dragstart', dragHandler);
      mountRoot.removeEventListener('dragend', dragEndHandler);
      mountRoot.classList.remove('milkdown-preview-host');
      const instance = instanceRef.current;
      instanceRef.current = null;
      if (instance) void instance.destroy();
      // Shadow roots cannot be detached from their host. We just clear
      // children so a subsequent mount starts fresh.
      if (createdShadow) {
        while (createdShadow.firstChild) {
          createdShadow.removeChild(createdShadow.firstChild);
        }
      }
    };
    // Re-mount when isolation or drag mode toggles (rare, expected).
  }, [isolate, enableBlockDrag]);

  useEffect(() => {
    if (markdownEquals(markdown, lastSyncedRef.current)) return;
    const next = normalizeMarkdown(markdown);
    const instance = instanceRef.current;
    if (!instance) {
      pendingMarkdownRef.current = next;
      return;
    }
    lastSyncedRef.current = next;
    instance.setMarkdown(next);
  }, [markdown]);

  // ---- Capture handlers that suppress editing when in drag-only mode ----
  // These mirror the legacy BlockNoteCard's defensive wrappers. They are
  // installed on the host div so they catch events even after they leave
  // the Shadow DOM (events retarget at shadow boundaries).
  const onBeforeInputCapture = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      if (!enableBlockDrag) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [enableBlockDrag],
  );
  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!enableBlockDrag) return;
      if (!shouldSwallowKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [enableBlockDrag],
  );
  const onPasteCapture = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (!enableBlockDrag) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [enableBlockDrag],
  );
  const onCutCapture = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (!enableBlockDrag) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [enableBlockDrag],
  );
  const onDropCapture = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!enableBlockDrag) return;
      e.preventDefault();
      e.stopPropagation();
    },
    [enableBlockDrag],
  );

  return (
    <div
      ref={containerRef}
      className={className}
      onBeforeInputCapture={onBeforeInputCapture}
      onKeyDownCapture={onKeyDownCapture}
      onPasteCapture={onPasteCapture}
      onCutCapture={onCutCapture}
      onDropCapture={onDropCapture}
    />
  );
}
