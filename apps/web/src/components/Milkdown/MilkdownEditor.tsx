// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

import {
  cloneArtifactToCanvas,
  resolveArtifactUrl,
  uploadImage as uploadImageApi,
} from '@/api/artifact';

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
   * Canvas id used to (a) resolve artifact-key image `src`s to fetchable
   * URLs for display and (b) upload pasted / dropped images to this
   * canvas' artifact store. When omitted, images render with their raw
   * `src` and paste / drop upload is disabled.
   */
  canvasId?: string;
  /**
   * Phase 4 provenance. The editor only renders the `blocks` half
   * (block-level highlights via `Decoration.node`); `tombstones` is
   * forwarded through the spec only so consumers can render their own
   * portal-based overlays without re-deriving anchor DOMs.
   */
  decorations?: MilkdownDecorationSpec;
  /**
   * Fires immediately BEFORE an external `markdown` prop change is
   * applied to the editor. Provides snapshots of block fingerprint
   * keys + their per-block markdown for both the outgoing (current)
   * and incoming (next) document, so callers can stamp provenance
   * without having to parse markdown themselves.
   *
   * Not fired for user edits (those flow through `onChange`).
   */
  onExternalUpdate?: (snap: {
    oldKeys: string[];
    newKeys: string[];
    oldMarkdownByKey: Map<string, string>;
    newMarkdownByKey: Map<string, string>;
  }) => void;
  /**
   * Receives the underlying instance once it has finished mounting.
   * Useful for callers that need the block-DOM lookups (tombstone
   * overlays). Called with `null` on unmount.
   */
  onReady?: (instance: MilkdownInstance | null) => void;
  /**
   * Fires when the user drags a block (or a multi-block selection) out
   * of the editor — typically used by note nodes to construct the
   * canvas drop payload. The Huabu markdown payload is exposed via
   * `event.markdown`; consumers are responsible for calling
   * `setData(HUABU_DND_MIME, …)` on `event.nativeEvent.dataTransfer`
   * (the helper already manages the drag image).
   */
  onBlockDragStart?: (event: MilkdownBlockDragEvent) => void;
}

export function MilkdownEditor(props: MilkdownEditorProps): React.JSX.Element {
  const {
    markdown,
    onChange,
    editable = true,
    placeholder,
    className,
    canvasId,
    decorations,
    onExternalUpdate,
    onReady,
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
  /** Track latest external-update callback. */
  const onExternalUpdateRef = useRef(onExternalUpdate);
  onExternalUpdateRef.current = onExternalUpdate;
  /** Track latest onReady callback. */
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  /** Track latest canvasId so the mount-only editor reads a fresh value. */
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;

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
        toolbarMode: 'huabu',
        resolveImageSrc: (src) => {
          const id = canvasIdRef.current;
          return id ? resolveArtifactUrl(src, id) : src;
        },
        uploadImage: async (file) => {
          const id = canvasIdRef.current;
          if (!id) throw new Error('No Space bound for image upload');
          return uploadImageApi(file, id);
        },
        importImage: async ({ src, srcCanvasId }) => {
          const id = canvasIdRef.current;
          if (!id) throw new Error('No Space bound for image import');
          if (!srcCanvasId) return src;
          const imported = await cloneArtifactToCanvas(srcCanvasId, src, id);
          if (!imported) throw new Error('Image artifact is missing');
          return imported;
        },
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
      onReadyRef.current?.(instance);

      // Apply any prop change that landed during the async mount.
      const pending = pendingMarkdownRef.current;
      pendingMarkdownRef.current = null;
      if (pending !== null && pending !== lastSyncedRef.current) {
        lastSyncedRef.current = pending;
        applyExternal(instance, pending);
      }
    })();

    return () => {
      cancelled = true;
      detachDrag();
      const instance = instanceRef.current;
      instanceRef.current = null;
      onReadyRef.current?.(null);
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
    applyExternal(instance, next);
  }, [markdown]);

  // Reconcile editable toggle.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.setReadonly(!editable);
  }, [editable]);

  // Reconcile decorations. Pushed every render with a referentially
  // stable spec means the consumer should memoize; we do not deep-diff.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    instance.setBlockDecorations(decorations?.blocks ?? []);
  }, [decorations]);

  /**
   * Apply an external markdown update and emit before/after fingerprint
   * snapshots so callers can stamp provenance. Used for both the
   * in-flight-mount catch-up and the steady-state reconcile.
   *
   * Both pre- and post-snapshots are taken with `instance.snapshotBlocks()`
   * which traverses the doc once and lazily resolves per-key markdown,
   * keeping the whole pass O(N).
   */
  function applyExternal(
    instance: MilkdownInstance,
    incomingMarkdown: string,
  ): void {
    const cb = onExternalUpdateRef.current;
    let oldKeys: string[] = [];
    const oldMarkdownByKey = new Map<string, string>();
    if (cb) {
      const before = instance.snapshotBlocks();
      oldKeys = before.keys;
      for (const k of oldKeys) {
        const md = before.getMarkdown(k);
        if (md !== null) oldMarkdownByKey.set(k, md);
      }
    }
    instance.setMarkdown(incomingMarkdown);
    if (cb) {
      const after = instance.snapshotBlocks();
      const newKeys = after.keys;
      const newMarkdownByKey = new Map<string, string>();
      for (const k of newKeys) {
        const md = after.getMarkdown(k);
        if (md !== null) newMarkdownByKey.set(k, md);
      }
      cb({ oldKeys, newKeys, oldMarkdownByKey, newMarkdownByKey });
    }
  }

  return <div ref={rootRef} className={className} />;
}
