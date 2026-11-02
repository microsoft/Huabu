// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Read-only Milkdown surface for AI message bubbles and collapsed note
 * previews.
 *
 * The editor mounts in plain (light) DOM. All Milkdown / Crepe theme
 * rules are scoped under `.milkdown` (see `milkdown-overrides.css`),
 * so no extra style isolation is required around the preview surface.
 *
 * In mouse mode, `enableBlockDrag` mounts the editor as editable so
 * Crepe's block handle is available, but all input mutations are
 * suppressed via DOM capture handlers. The `previewMode` option
 * additionally disables the floating Toolbar / LinkTooltip / Table
 * chrome so the surface looks genuinely read-only without resorting
 * to CSS hacks.
 * Touch/Pen mode uses non-editable DOM and an independent pointer grip.
 *
 * Multi-block drag is delegated to `attachBlockDragListeners` (shared
 * with `MilkdownEditor`); see `blockDrag.ts` for design notes.
 */

import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { useEffectiveInputMode } from '@/hooks/useInputMode';
import { useLinkFollowModifierHeld } from '@/hooks/useMultiSelectModifier';
import { useSearchSource } from '@/hooks/useSearchSource';

import { attachBlockDragListeners } from './blockDrag';
import {
  createMilkdown,
  type MilkdownInstance,
  type MilkdownTextSelection,
} from './createMilkdown';
import { markdownEquals, normalizeMarkdown } from './markdownUtils';
import {
  TouchBlockDragHandle,
  type GetTouchDragPayload,
} from './TouchBlockDragHandle';

import type { MilkdownBlockDragEvent, MilkdownLinkActivation } from './types';
export interface MilkdownPreviewProps {
  markdown: string;
  className?: string;
  /** Accessible name for the rendered read-only rich-text surface. */
  ariaLabel?: string;
  linkActivation?: MilkdownLinkActivation;
  onLinkClick?: (href: string) => void;
  /**
   * Canvas id used to resolve artifact-key image `src`s (e.g.
   * `art_abc.png`) into fetchable URLs for the rendered `<img>`. When
   * omitted, image srcs render verbatim.
   */
  canvasId?: string;
  /**
   * Show Crepe's block drag handle and call `onBlockDragStart` when the
   * user starts dragging a block out of the editor. Default `false`.
   */
  enableBlockDrag?: boolean;
  /** Fires alongside Crepe's native drag handler when a block drag begins. */
  onBlockDragStart?: (event: MilkdownBlockDragEvent) => void;
  getTouchDragPayload?: GetTouchDragPayload;
  /** Reports only native text selections wholly inside this preview. */
  onTextSelection?: (selection: MilkdownPreviewSelection | null) => void;
}

export interface MilkdownPreviewSelection extends MilkdownTextSelection {
  position: { x: number; y: number };
}

/**
 * Keys that we still want to bubble even in drag-only readonly mode.
 *
 * NOTE: `Tab` is intentionally NOT in this set. ProseMirror's keymap
 * treats Tab as an editing verb (indent list item / change nesting /
 * move selection across blocks), so we have to keep the event from
 * reaching the editor. See the dedicated branch in `onKeyDownCapture`
 * below — it stops propagation without calling `preventDefault`, so
 * the browser's native focus navigation still works.
 */
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
]);

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

function shouldSwallowKey(e: React.KeyboardEvent): boolean {
  if (MODIFIER_KEYS.has(e.key) || NAV_KEYS.has(e.key)) return false;
  // Tab is handled by its own branch in `onKeyDownCapture` — don't
  // route it through the generic preventDefault path here, since that
  // would also block browser focus navigation.
  if (e.key === 'Tab') return false;
  const key = e.key.toLowerCase();
  // Preserve copy / select-all so the user can still pull text out.
  const isCopyOrSelectAll =
    (e.ctrlKey || e.metaKey) && (key === 'c' || key === 'a');
  if (isCopyOrSelectAll) return false;
  return true;
}

export function MilkdownPreview(
  props: MilkdownPreviewProps,
): React.JSX.Element {
  const { t } = useTranslation();
  const {
    markdown,
    className,
    ariaLabel,
    canvasId,
    enableBlockDrag = false,
    onBlockDragStart,
    getTouchDragPayload,
    linkActivation = 'plain',
    onLinkClick,
    onTextSelection,
  } = props;
  const resolvedAriaLabel = ariaLabel ?? t('editor.readOnlyContent');
  const touchMode = useEffectiveInputMode() !== 'mouse';
  const nativeDragEditable = enableBlockDrag && !touchMode;
  const editableRef = useRef(nativeDragEditable);
  editableRef.current = nativeDragEditable;
  const [touchInstance, setTouchInstance] = useState<MilkdownInstance | null>(
    null,
  );
  const followModifierHeld = useLinkFollowModifierHeld(
    linkActivation === 'modifier',
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<MilkdownInstance | null>(null);
  useSearchSource(containerRef, markdown, 'markdown', instanceRef);
  const lastSyncedRef = useRef<string>(normalizeMarkdown(markdown));
  const pendingMarkdownRef = useRef<string | null>(null);
  const selectingWithMouseRef = useRef(false);
  // Keep the latest drag callback in a ref so the mount effect stays
  // stable while still reading fresh closures.
  const onBlockDragStartRef = useRef(onBlockDragStart);
  onBlockDragStartRef.current = onBlockDragStart;
  /** Track latest canvasId so the mount-only editor reads a fresh value. */
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;
  const ariaLabelRef = useRef(resolvedAriaLabel);
  ariaLabelRef.current = resolvedAriaLabel;
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;
  const hasLinkCallback = !!onLinkClick;
  const onTextSelectionRef = useRef(onTextSelection);
  onTextSelectionRef.current = onTextSelection;
  const reportsTextSelection = !!onTextSelection;

  const syncPendingMarkdown = useCallback(() => {
    const instance = instanceRef.current;
    const pending = pendingMarkdownRef.current;
    if (!instance || pending === null) return;
    pendingMarkdownRef.current = null;
    if (pending === lastSyncedRef.current) return;
    lastSyncedRef.current = pending;
    instance.setMarkdown(pending);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // Milkdown mounts directly into the host container (light DOM).
    // See the file-level comment for why Shadow DOM isolation was
    // removed.
    const mountRoot: HTMLElement = container;

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
        editable: editableRef.current,
        ariaLabel: ariaLabelRef.current,
        // Disable Crepe's edit-time chrome (Toolbar / LinkTooltip /
        // Table reorder handles) when the surface is drag-only. See
        // `MilkdownFactoryOptions.previewMode`.
        previewMode: enableBlockDrag,
        toolbarMode: 'none',
        linkActivation,
        onLinkClick: hasLinkCallback
          ? (href) => onLinkClickRef.current?.(href)
          : undefined,
        resolveImageSrc: (src) => {
          const id = canvasIdRef.current;
          return id ? resolveArtifactUrl(src, id) : src;
        },
      });

      if (cancelled) {
        await instance.destroy();
        return;
      }

      instance.setAriaLabel(ariaLabelRef.current);
      instance.setReadonly(!editableRef.current);
      instanceRef.current = instance;
      setTouchInstance(instance);
      mountRoot.setAttribute('data-search-source-ready', '');

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
      const instance = instanceRef.current;
      instanceRef.current = null;
      setTouchInstance(null);
      mountRoot.removeAttribute('data-search-source-ready');
      if (instance) void instance.destroy();
    };
    // Re-mount when drag mode toggles (rare, expected).
  }, [enableBlockDrag, linkActivation, hasLinkCallback]);

  useEffect(() => {
    instanceRef.current?.setReadonly(!nativeDragEditable);
  }, [nativeDragEditable]);

  useEffect(() => {
    const mountRoot = containerRef.current;
    if (!reportsTextSelection || !mountRoot) return;
    let frame: number | undefined;
    let hasReportedSelection = false;
    let mousePosition: { x: number; y: number } | null = null;
    let mouseSelectionRect: DOMRect | null = null;
    const clearMousePosition = () => {
      mousePosition = null;
      mouseSelectionRect = null;
    };
    const report = () => {
      frame = undefined;
      const instance = instanceRef.current;
      const native = mountRoot.ownerDocument.getSelection();
      const editor = mountRoot.querySelector('.ProseMirror');
      if (
        !instance ||
        !editor ||
        !native ||
        native.isCollapsed ||
        native.rangeCount !== 1 ||
        !native.anchorNode ||
        !native.focusNode ||
        !editor.contains(native.anchorNode) ||
        !editor.contains(native.focusNode)
      ) {
        hasReportedSelection = false;
        clearMousePosition();
        onTextSelectionRef.current?.(null);
        if (!selectingWithMouseRef.current) syncPendingMarkdown();
        return;
      }
      const snapshot = instance.getTextSelection();
      const rect = instance.getSelectionClientRect();
      hasReportedSelection = !!snapshot && !!rect;
      if (!snapshot || !rect) {
        clearMousePosition();
        onTextSelectionRef.current?.(null);
        if (!selectingWithMouseRef.current) syncPendingMarkdown();
        return;
      }
      let position: { x: number; y: number };
      if (mousePosition) {
        mouseSelectionRect ??= rect;
        position = {
          x: mousePosition.x + rect.left - mouseSelectionRect.left,
          y: mousePosition.y + rect.top - mouseSelectionRect.top,
        };
      } else {
        const focusRange = mountRoot.ownerDocument.createRange();
        focusRange.setStart(native.focusNode, native.focusOffset);
        focusRange.collapse(true);
        const focusRect = focusRange.getBoundingClientRect();
        position =
          focusRect.height > 0
            ? { x: focusRect.left, y: focusRect.bottom }
            : { x: rect.right, y: rect.bottom };
      }
      onTextSelectionRef.current?.({ ...snapshot, position });
    };
    const schedule = () => {
      const native = mountRoot.ownerDocument.getSelection();
      if (
        !hasReportedSelection &&
        pendingMarkdownRef.current === null &&
        !mountRoot.contains(native?.anchorNode ?? null) &&
        !mountRoot.contains(native?.focusNode ?? null)
      ) {
        return;
      }
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(report);
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      selectingWithMouseRef.current = true;
      clearMousePosition();
    };
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (
        !selectingWithMouseRef.current &&
        (!(event.target instanceof Node) || !mountRoot.contains(event.target))
      ) {
        return;
      }
      selectingWithMouseRef.current = false;
      mousePosition = { x: event.clientX, y: event.clientY };
      mouseSelectionRect = null;
      schedule();
    };
    const handleDragEnd = () => {
      selectingWithMouseRef.current = false;
      clearMousePosition();
      schedule();
    };
    const handleKeyUp = () => {
      clearMousePosition();
      schedule();
    };
    const doc = mountRoot.ownerDocument;
    doc.addEventListener('selectionchange', schedule);
    mountRoot.addEventListener('mousedown', handleMouseDown);
    mountRoot.addEventListener('dragend', handleDragEnd);
    doc.addEventListener('mouseup', handleMouseUp);
    mountRoot.addEventListener('keyup', handleKeyUp);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      doc.removeEventListener('selectionchange', schedule);
      mountRoot.removeEventListener('mousedown', handleMouseDown);
      mountRoot.removeEventListener('dragend', handleDragEnd);
      doc.removeEventListener('mouseup', handleMouseUp);
      mountRoot.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      selectingWithMouseRef.current = false;
      onTextSelectionRef.current?.(null);
      syncPendingMarkdown();
    };
  }, [reportsTextSelection, syncPendingMarkdown]);

  useEffect(() => {
    if (markdownEquals(markdown, lastSyncedRef.current)) {
      pendingMarkdownRef.current = null;
      return;
    }
    const next = normalizeMarkdown(markdown);
    pendingMarkdownRef.current = next;
    if (reportsTextSelection) {
      const container = containerRef.current;
      const editor = container?.querySelector('.ProseMirror');
      const native = container?.ownerDocument.getSelection();
      // Replacing the document during selection would destroy the quoted range.
      if (
        selectingWithMouseRef.current ||
        (native &&
          !native.isCollapsed &&
          native.rangeCount === 1 &&
          editor?.contains(native.anchorNode) &&
          editor.contains(native.focusNode))
      ) {
        return;
      }
    }
    syncPendingMarkdown();
  }, [markdown, reportsTextSelection, syncPendingMarkdown]);

  // The editor mounts asynchronously, so the mount path above applies the
  // initial name. Keep the live textbox in sync when the caller overrides
  // the label or the active language changes without remounting Milkdown.
  useEffect(() => {
    instanceRef.current?.setAriaLabel(resolvedAriaLabel);
  }, [resolvedAriaLabel]);

  // ---- Capture handlers that suppress editing when in drag-only mode ----
  // Installed on the host div so they intercept input verbs before
  // ProseMirror sees them.
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
      // Tab is special: ProseMirror's keymap binds it to indent /
      // change list nesting / move selection between cells, all of
      // which mutate the document. Stop the event from reaching the
      // editor but DON'T call preventDefault — that way the browser
      // still moves keyboard focus to the next focusable element,
      // which is the accessibility-correct behavior for a read-only
      // surface.
      if (e.key === 'Tab') {
        e.stopPropagation();
        return;
      }
      // Focused anchors keep native keyboard activation; the shared click
      // handler still validates and routes the resulting detail=0 click.
      if (e.key === 'Enter' && e.target instanceof HTMLAnchorElement) {
        e.stopPropagation();
        return;
      }
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
    <>
      <div
        ref={containerRef}
        data-search-renderer
        data-link-follow-held={
          linkActivation === 'modifier' ? String(followModifierHeld) : undefined
        }
        className={clsx('[&_a]:pointer-events-auto', className, {
          'milkdown-preview-host': enableBlockDrag,
          'milkdown-touch-blocks':
            enableBlockDrag && touchMode && getTouchDragPayload,
        })}
        // Surface the read-only nature to assistive tech. In drag mode
        // we still keep the inner ProseMirror `contenteditable=true` so
        // the block-drag handle remains hit-testable, but we capture &
        // swallow every input verb (typing, paste, cut, drop) above —
        // so the visible behavior is read-only. `aria-readonly` lets
        // screen readers convey that to the user. Pure-display mode
        // (no block drag) keeps `aria-readonly` unset because
        // `contenteditable=false` already communicates read-only.
        aria-readonly={enableBlockDrag ? true : undefined}
        onBeforeInputCapture={onBeforeInputCapture}
        onKeyDownCapture={onKeyDownCapture}
        onPasteCapture={onPasteCapture}
        onCutCapture={onCutCapture}
        onDropCapture={onDropCapture}
      />
      {enableBlockDrag &&
      touchMode &&
      getTouchDragPayload &&
      touchInstance &&
      containerRef.current ? (
        <TouchBlockDragHandle
          root={containerRef.current}
          instance={touchInstance}
          getPayload={getTouchDragPayload}
        />
      ) : null}
    </>
  );
}
