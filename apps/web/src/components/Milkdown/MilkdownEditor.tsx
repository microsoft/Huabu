/**
 * Editable Milkdown surface.
 *
 * Controlled component: `markdown` is the source of truth. Internally
 * we run a Crepe instance and reconcile in both directions:
 *  - user edits  → markdownUpdated  → normalize → `onChange`
 *  - prop change → `setMarkdown` (only when the new prop normalizes to
 *    something different from what the editor last emitted)
 *
 * The `lastSyncedRef` guard is what prevents the classic feedback loop
 * (parent echoes back our `onChange`, we'd `setMarkdown` it back and
 * reset the user's selection).
 *
 * Dragging blocks out of the editor onto the canvas works through the
 * shared `attachBlockDragListeners` helper (same code path the
 * `MilkdownPreview` chat cards use). When `onBlockDragStart` is
 * supplied, the helper installs capture/bubble listeners that snapshot
 * the (possibly multi-block) text selection on mousedown, rebuild a
 * unified drag preview on dragstart, and forward a markdown payload to
 * the consumer. Crepe's own internal drag (used for in-editor block
 * reorder) keeps working because we only wrap, never replace, its
 * default behavior.
 */

import { useEffect, useRef } from 'react';

import { attachBlockDragListeners } from './blockDrag';
import { createMilkdown, type MilkdownInstance } from './createMilkdown';
import { markdownEquals, normalizeMarkdown } from './markdownUtils';

import type { MilkdownBlockDragEvent, MilkdownDecorationSpec } from './types';

export interface MilkdownEditorProps {
  /** Source of truth. Controlled. */
  markdown: string;
  /** Fired with normalized markdown (LF line endings, trailing trimmed). */
  onChange?: (next: string) => void;
  /** Default `true`. */
  editable?: boolean;
  /** Optional placeholder shown when the document is empty. */
  placeholder?: string;
  /** Optional className applied to the editor root. */
  className?: string;
  /**
   * Reserved for Phase 4 provenance. Accepted but unused in Phase 1b.
   */
  decorations?: MilkdownDecorationSpec;
  /**
   * Fires when the user drags a block (or a multi-block selection) out
   * of the editor — typically used by note nodes to construct the
   * canvas drop payload. The Sediment markdown payload is exposed via
   * `event.markdown`; consumers are responsible for calling
   * `setData(SEDIMENT_DND_MIME, …)` on `event.nativeEvent.dataTransfer`
   * (the helper already manages the drag image).
   */
  onBlockDragStart?: (event: MilkdownBlockDragEvent) => void;
}

export function MilkdownEditor(props: MilkdownEditorProps): JSX.Element {
  const {
    markdown,
    onChange,
    editable = true,
    placeholder,
    className,
    onBlockDragStart,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<MilkdownInstance | null>(null);
  /** Most recent value either set on or emitted from the editor. */
  const lastSyncedRef = useRef<string>(normalizeMarkdown(markdown));
  /** Markdown queued while the async mount is in flight. */
  const pendingMarkdownRef = useRef<string | null>(null);
  /** Track latest `onChange` without re-mounting the editor. */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** Track latest drag callback without re-mounting the editor. */
  const onBlockDragStartRef = useRef(onBlockDragStart);
  onBlockDragStartRef.current = onBlockDragStart;

  // Mount the editor once. The async lifecycle is guarded with a
  // `cancelled` flag so React 18 StrictMode's double-effect cleans up
  // the first attempt before the second mount runs.
  useEffect(() => {
    let cancelled = false;
    const root = rootRef.current;
    if (!root) return;

    // Install the drag-out listeners up-front: they are no-ops while
    // `onBlockDragStartRef.current` is undefined, and self-update via
    // the ref when the prop changes between renders without forcing a
    // re-mount of Crepe.
    const detachDrag = attachBlockDragListeners({
      mountRoot: root,
      instanceRef,
      onDragStartRef: onBlockDragStartRef,
    });

    void (async () => {
      const instance = await createMilkdown({
        root,
        initialMarkdown: lastSyncedRef.current,
        editable,
        placeholder,
      });

      if (cancelled) {
        await instance.destroy();
        return;
      }

      instance.onMarkdownUpdated((raw) => {
        const next = normalizeMarkdown(raw);
        if (next === lastSyncedRef.current) return;
        lastSyncedRef.current = next;
        onChangeRef.current?.(next);
      });

      instanceRef.current = instance;

      // Apply any prop change that landed during the async mount.
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
      if (instance) void instance.destroy();
    };
    // Intentionally mount-only: `editable`, `placeholder` are handled by
    // dedicated effects below. We never want to tear down on prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile external markdown changes.
  useEffect(() => {
    if (markdownEquals(markdown, lastSyncedRef.current)) return;
    const next = normalizeMarkdown(markdown);
    const instance = instanceRef.current;
    if (!instance) {
      // Mount still in flight — queue the value for application.
      pendingMarkdownRef.current = next;
      return;
    }
    lastSyncedRef.current = next;
    instance.setMarkdown(next);
  }, [markdown]);

  // Reconcile editable toggle.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.setReadonly(!editable);
  }, [editable]);

  return <div ref={rootRef} className={className} />;
}
