/**
 * Read-only Milkdown surface, optionally isolated in a Shadow DOM.
 *
 * Used for AI message bubbles and other read-only previews. Shadow DOM
 * isolation keeps Milkdown's CSS from leaking into the surrounding
 * page (and vice-versa) without giving up document-level styles,
 * thanks to `applySharedStyles`.
 *
 * When `enableBlockDrag` is set, the editor is mounted as editable so
 * Crepe's block handle is available, but all input mutations are
 * suppressed via DOM capture handlers. The `previewMode` option
 * additionally disables the floating Toolbar / LinkTooltip / Table
 * chrome so the surface looks genuinely read-only without resorting
 * to CSS hacks.
 *
 * Multi-block drag is delegated to `attachBlockDragListeners` (shared
 * with `MilkdownEditor`); see `blockDrag.ts` for design notes.
 */

import { useCallback, useEffect, useRef } from 'react';

import { applySharedStyles } from '@/utils/shadowStyleCache';

import { attachBlockDragListeners } from './blockDrag';
import { createMilkdown, type MilkdownInstance } from './createMilkdown';
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

    const detachDrag = attachBlockDragListeners({
      mountRoot,
      instanceRef,
      onDragStartRef: onBlockDragStartRef,
    });

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
      detachDrag();
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
  // Installed on the host div so they catch events even after they
  // leave the Shadow DOM (events retarget at shadow boundaries).
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
