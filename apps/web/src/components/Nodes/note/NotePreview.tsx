// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Milkdown-backed note preview.
 *
 * Implements the `PreviewComponentProps` contract shared by every
 * preview surface so the rest of the canvas / agent stack treats notes
 * uniformly.
 *
 * Block provenance: AI edits are stamped authoritatively by the server
 * (the shared canvas engine computes `data.provenance` at the mutation
 * source and broadcasts it with the content delta), so this component
 * simply renders `data.provenance`. When the editor re-serializes the
 * doc, `onExternalUpdate` lets us realign existing markers to the live
 * block keys via `shiftProvenance`; user edits clear markers the same
 * way. Accept / Reject / Restore / Dismiss UI is rendered by
 * `<ProvenanceOverlay>`.
 *
 * Set `VITE_PROVENANCE=off` in `.env` to disable Phase 4 entirely
 * (decoration-less, overlay-less editor — useful for bisecting bugs
 * during iteration).
 */

import { Code2, FileText, Sparkles } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { MilkdownEditor } from '@/components/Milkdown';
import { MilkdownFloatingToolbar } from '@/components/Milkdown/MilkdownFloatingToolbar';
import { usePreviewHeaderSlot } from '@/components/Nodes/PreviewHeaderSlot';
import { usePreviewScrollMemory } from '@/hooks/usePreviewScrollMemory';
import useCanvasStore from '@/store/canvasStore';
import {
  coerceProvenance,
  dismissDeletedBlock,
  dropBlockEntry,
  emptyProvenance,
  shiftProvenance,
} from '@/utils/blockProvenance';
import {
  canReadHuabuPayload,
  getHuabuPayload,
  setDragPayload,
} from '@/utils/io/dragDrop';
import { dragPayloadToMarkdown } from '@/utils/io/payloadToMarkdown';

import { ProvenanceOverlay } from './ProvenanceOverlay';

import type {
  MilkdownBlockDragEvent,
  MilkdownDecorationSpec,
  MilkdownInstance,
} from '@/components/Milkdown';
import type { NoteDragPayload } from '@/utils/io/dragDrop';
import type { MarkdownProvenance, NodeOrigin } from '@huabu/shared';

const PROVENANCE_ENABLED = (import.meta.env.VITE_PROVENANCE ?? 'on') !== 'off';

const AI_BLOCK_CLASSNAME = 'huabu-ai-edited-block';

// Lazy-load the CodeMirror-based raw editor. Keeps the ~80kb gzipped
// chunk out of the initial bundle — only users that actually open
// raw-markdown mode pay for it. Default export on the module means
// `React.lazy` can be used without an extra wrapper.
const RawMarkdownEditor = lazy(
  () => import('@/components/CodeMirror/RawMarkdownEditor'),
);

export interface PreviewComponentProps {
  /** Canvas node id, when this preview is bound to a real node. */
  id?: string;
  /** Runtime identity used to restore this Preview target's scroll offset. */
  scrollViewKey?: string;
  data: Record<string, unknown>;
  readOnly?: boolean;
  /** One-shot focus request owned by the containing preview tab. */
  focusRequestNonce?: number;
  onFocusRequestHandled?: (nonce: number) => void;
  /** Called with a plain string for backward-compat consumers. */
  onContentChange?: (newContent: string) => void;
  /**
   * Preferred over `onContentChange` when available. Phase 4 writes
   * both `content` (Markdown) and `provenance` (`MarkdownProvenance`)
   * via this hook.
   */
  onDataChange?: (patch: Record<string, unknown>) => void;
}

export const NotePreview = ({
  id,
  scrollViewKey,
  data,
  readOnly,
  focusRequestNonce,
  onFocusRequestHandled,
  onContentChange,
  onDataChange,
}: PreviewComponentProps) => {
  const { t } = useTranslation();
  // `content` is the canonical Markdown string. Brand-new note records
  // may have it absent or non-string; normalise to empty.
  const markdown = typeof data.content === 'string' ? data.content : '';
  const provenance: MarkdownProvenance = useMemo(
    () =>
      PROVENANCE_ENABLED
        ? coerceProvenance(data.provenance)
        : emptyProvenance(),
    [data.provenance],
  );

  // Defense-in-depth dedup against parents echoing our own emits.
  const lastEmittedMarkdownRef = useRef<string>(markdown);
  lastEmittedMarkdownRef.current = markdown;

  // Track latest provenance for callback handlers (so they see the
  // freshest snapshot without re-binding on every render).
  const provenanceRef = useRef<MarkdownProvenance>(provenance);
  provenanceRef.current = provenance;

  const [editor, setEditor] = useState<MilkdownInstance | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  usePreviewScrollMemory(containerRef, scrollViewKey);

  // Edit-mode toggle: rich-text WYSIWYG (Milkdown) vs raw markdown
  // (textarea). Provenance overlays and the batch accept/reject chip
  // are block-key driven, so they only render in WYSIWYG mode. The
  // switch is purely a presentation choice — the underlying
  // `data.content` is the same Markdown string in both modes.
  const [editMode, setEditMode] = useState<'wysiwyg' | 'raw'>('wysiwyg');

  const writePatch = useCallback(
    (patch: Record<string, unknown>) => {
      if (onDataChange) {
        onDataChange(patch);
      } else if (onContentChange && typeof patch.content === 'string') {
        onContentChange(patch.content);
      }
    },
    [onDataChange, onContentChange],
  );

  const handleEditorChange = useCallback(
    (next: string) => {
      if (readOnly) return;
      if (!onContentChange && !onDataChange) return;
      if (next === lastEmittedMarkdownRef.current) return;

      lastEmittedMarkdownRef.current = next;

      // User edit: shift provenance against the live block keys so any
      // edited block self-clears its marker.
      if (PROVENANCE_ENABLED && editor) {
        const liveKeys = editor.getBlockKeys();
        const shifted = shiftProvenance(provenanceRef.current, liveKeys);
        if (
          shifted.blocks.length !== provenanceRef.current.blocks.length ||
          shifted.deletedBlocks.length !==
            provenanceRef.current.deletedBlocks.length
        ) {
          provenanceRef.current = shifted;
          writePatch({ content: next, provenance: shifted });
          return;
        }
      }

      writePatch({ content: next });
    },
    [readOnly, onContentChange, onDataChange, editor, writePatch],
  );

  const handleExternalUpdate = useCallback<
    NonNullable<React.ComponentProps<typeof MilkdownEditor>['onExternalUpdate']>
  >(
    ({ oldKeys, newKeys }) => {
      if (!PROVENANCE_ENABLED) return;
      // Pure key-equal => nothing to do (e.g. content normalized
      // round-trip with no actual block change).
      if (
        oldKeys.length === newKeys.length &&
        oldKeys.every((k, i) => k === newKeys[i])
      ) {
        return;
      }
      // Provenance for AI edits is authored by the server and arrives via
      // `data.provenance`; the client never stamps here. This handler only
      // realigns existing markers to the live block keys so they stay
      // attached when the doc shape shifts (e.g. another panel echoing the
      // user's edit on the same node, or a server delta the editor
      // re-serialized slightly differently).
      const shifted = shiftProvenance(provenanceRef.current, newKeys);
      if (
        shifted.blocks.length !== provenanceRef.current.blocks.length ||
        shifted.deletedBlocks.length !==
          provenanceRef.current.deletedBlocks.length
      ) {
        provenanceRef.current = shifted;
        writePatch({ provenance: shifted });
      }
    },
    [writePatch],
  );

  // Build the decoration spec from current provenance. Memoized so
  // MilkdownEditor's decoration effect doesn't fire on every render.
  const decorations: MilkdownDecorationSpec | undefined = useMemo(() => {
    if (!PROVENANCE_ENABLED) return undefined;
    if (provenance.blocks.length === 0 && provenance.deletedBlocks.length === 0)
      return undefined;
    return {
      blocks: provenance.blocks.map((b) => ({
        key: b.key,
        className: AI_BLOCK_CLASSNAME,
      })),
    };
  }, [provenance]);

  // Provenance action handlers.
  const handleAcceptBlock = useCallback(
    (key: string) => {
      // Accept: keep the AI rewrite as-is, just drop the marker.
      const next = dropBlockEntry(provenanceRef.current, key);
      provenanceRef.current = next;
      writePatch({ provenance: next });
    },
    [writePatch],
  );

  const handleRejectBlock = useCallback(
    (key: string) => {
      if (!editor) return;
      const entry = provenanceRef.current.blocks.find((b) => b.key === key);
      if (!entry) return;
      // Reject = restore the block to its pre-AI state AND drop the
      // provenance entry. The `dropBlockEntry` helper is purely
      // bookkeeping — the visible mutation happens via the editor
      // verb below.
      const next = dropBlockEntry(provenanceRef.current, key);
      provenanceRef.current = next;
      // Pure inserts have no baseline — Reject means "delete the block".
      // Modifications restore the pre-edit content.
      const ok =
        entry.kind === 'inserted'
          ? editor.deleteBlockByKey(key)
          : editor.replaceBlockByKey(key, entry.baselineMarkdown);
      if (!ok) return;
      const newContent = editor.getMarkdown();
      lastEmittedMarkdownRef.current = newContent;
      writePatch({ content: newContent, provenance: next });
    },
    [editor, writePatch],
  );

  // "Insert Below" — restore the original block to its baseline AND
  // keep the AI version as a new block below it. Net effect: user has
  // both copies stacked, neither marked. The provenance entry for the
  // original key is dropped because the new fingerprint no longer
  // matches. Mirrors the pre-Milkdown behaviour.
  const handleInsertBelow = useCallback(
    (key: string, baselineMarkdown: string) => {
      if (!editor) return;
      const liveAi = editor.getBlockMarkdownByKey(key);
      if (liveAi === null) return;
      // Insert AI version FIRST while `key` is still resolvable; then
      // replace the original block with the baseline.
      const insertedOk = editor.insertBlocksAfter(key, liveAi);
      if (!insertedOk) return;
      const replacedOk = editor.replaceBlockByKey(key, baselineMarkdown);
      if (!replacedOk) return;
      // Drop the entry for `key`; both new fingerprints are unmarked.
      const next = dropBlockEntry(provenanceRef.current, key);
      provenanceRef.current = next;
      const newContent = editor.getMarkdown();
      lastEmittedMarkdownRef.current = newContent;
      writePatch({ content: newContent, provenance: next });
    },
    [editor, writePatch],
  );

  const handleRestoreTombstone = useCallback(
    (deletedKey: string, restoreMarkdown: string, anchorKey: string | null) => {
      if (!editor) return;
      const next = dismissDeletedBlock(provenanceRef.current, deletedKey);
      provenanceRef.current = next;
      const ok = editor.insertBlocksAfter(anchorKey, restoreMarkdown);
      if (!ok) return;
      const newContent = editor.getMarkdown();
      lastEmittedMarkdownRef.current = newContent;
      writePatch({ content: newContent, provenance: next });
    },
    [editor, writePatch],
  );

  const handleDismissTombstone = useCallback(
    (deletedKey: string) => {
      const next = dismissDeletedBlock(provenanceRef.current, deletedKey);
      provenanceRef.current = next;
      writePatch({ provenance: next });
    },
    [writePatch],
  );

  // Batch verdicts — apply to every live entry + tombstone in one go.
  // Useful when the AI has rewritten many blocks and the user just
  // wants to keep / discard the whole change set without clicking
  // through each block individually.
  const handleAcceptAll = useCallback(() => {
    const prov = provenanceRef.current;
    if (prov.blocks.length === 0 && prov.deletedBlocks.length === 0) return;
    // Accept all = keep the live doc, drop every marker / tombstone.
    const next = emptyProvenance();
    provenanceRef.current = next;
    writePatch({ provenance: next });
  }, [writePatch]);

  const handleRejectAll = useCallback(() => {
    if (!editor) return;
    const prov = provenanceRef.current;
    if (prov.blocks.length === 0 && prov.deletedBlocks.length === 0) return;
    const blockKeys = editor.getBlockKeys();
    const liveSet = new Set(blockKeys);
    const indexByKey = new Map<string, number>();
    blockKeys.forEach((k, i) => indexByKey.set(k, i));

    // 1. Roll back every live AI edit in REVERSE doc order. Deletes
    //    shift later positions earlier, and the helpers re-fingerprint
    //    on each call — walking back-to-front keeps later keys stable
    //    (incl. `#N` duplicate suffixes) while we mutate earlier ones.
    //    Stale entries (key no longer in the doc) are silently skipped.
    const sorted = prov.blocks
      .filter((b) => liveSet.has(b.key))
      .slice()
      .sort(
        (a, b) => (indexByKey.get(b.key) ?? 0) - (indexByKey.get(a.key) ?? 0),
      );
    for (const entry of sorted) {
      if (entry.kind === 'inserted') {
        editor.deleteBlockByKey(entry.key);
      } else {
        editor.replaceBlockByKey(entry.key, entry.baselineMarkdown);
      }
    }

    // 2. Re-insert tombstoned blocks. Multiple deletes sharing the
    //    same `anchorKey` are restored in REVERSE order so that each
    //    fresh insertion pushes the previously-restored block down,
    //    landing the original deletion order from top to bottom.
    for (const t of prov.deletedBlocks.slice().reverse()) {
      editor.insertBlocksAfter(t.anchorKey, t.baselineMarkdown);
    }

    // 3. Clear all bookkeeping — the doc is now baseline-equivalent.
    const next = emptyProvenance();
    provenanceRef.current = next;
    const newContent = editor.getMarkdown();
    lastEmittedMarkdownRef.current = newContent;
    writePatch({ content: newContent, provenance: next });
  }, [editor, writePatch]);

  // Push an extra decoration sync when the editor instance becomes
  // available (the prop-driven effect inside MilkdownEditor only fires
  // on subsequent prop changes — not on initial mount when decorations
  // were already known).
  useEffect(() => {
    if (!editor) return;
    editor.setBlockDecorations(decorations?.blocks ?? []);
  }, [editor, decorations]);

  // Needed to resolve artifact-key image srcs (e.g. `art_xxx.png`)
  // dragged in from chat so the inserted markdown carries a
  // fetchable HTTP URL rather than a bare key the renderer can't
  // dereference.
  const canvasId = useCanvasStore((s) => s.canvasId);
  // Explicit opens target one workspace tab. Consume the request after the
  // editor focuses so remounting that tab cannot replay stale focus intent.
  useEffect(() => {
    if (!editor) return;
    if (readOnly) return;
    if (editMode !== 'wysiwyg') return;
    if (focusRequestNonce === undefined) return;
    editor.focus();
    onFocusRequestHandled?.(focusRequestNonce);
  }, [editor, readOnly, editMode, focusRequestNonce, onFocusRequestHandled]);

  const handleBlockDragStart = useCallback(
    (event: MilkdownBlockDragEvent) => {
      const trimmed = event.markdown.trim();
      if (!trimmed) return;

      const origin: NodeOrigin = id
        ? { type: 'user-excerpt', excerptFromNodeId: id }
        : { type: 'user-excerpt' };

      const payload: Omit<NoteDragPayload & { origin: NodeOrigin }, 'dragId'> =
        {
          kind: 'note',
          origin,
          data: {
            content: trimmed,
            ...(id
              ? {
                  sourceNodeId: id,
                  sourceContentAfterMove: event.sourceContentAfterMove,
                }
              : {}),
          },
        };

      setDragPayload(event.nativeEvent as unknown as React.DragEvent, payload, {
        // 'all' (not 'copyMove') so macOS Cmd-modified drags still
        // dispatch a `drop` event — Cmd is reported as NSDragOperation
        // Generic/Link at the OS layer, which fails to intersect with
        // 'copyMove' and silently aborts the gesture.
        effectAllowed: 'all',
      });
    },
    [id],
  );

  // Raw-mode change handler. Mirrors the dedup guard used by
  // `handleEditorChange` so an echo of our own emit through the data
  // prop doesn't re-fire `writePatch`. Provenance is intentionally
  // not touched here — block-key based markers don't apply to raw
  // free-form text edits, and we want the user's existing markers to
  // survive a quick "switch → tweak → switch back" round-trip.
  const handleRawChange = useCallback(
    (next: string) => {
      if (readOnly) return;
      if (!onContentChange && !onDataChange) return;
      if (next === lastEmittedMarkdownRef.current) return;
      lastEmittedMarkdownRef.current = next;
      writePatch({ content: next });
    },
    [readOnly, onContentChange, onDataChange, writePatch],
  );

  // ── Drop target: external Huabu payloads (chat messages, image
  // / web cards) can be dropped into the editor to insert a new
  // block at the cursor position. Blocks dragged out of THIS note
  // and dropped back into it fall through to Crepe's native
  // in-editor reorder handler.
  //
  // CAPTURE-phase listeners on purpose. Crepe / Milkdown sets
  // `text/html` + `text/plain` on dataTransfer during dragstart
  // (see `blockDrag.ts`). ProseMirror's drop handler lives on the
  // inner `view.dom` element in the BUBBLE phase, so if we attached
  // bubble-phase React handlers they would fire AFTER ProseMirror
  // had already pasted the text/html fallback — producing a double
  // insertion. Capture phase fires top-down, lets us mark
  // `event.defaultPrevented`, and ProseMirror's bubble handler
  // checks that flag and bails out. Raw-markdown mode delegates to
  // the textarea's native drop behaviour.
  const handlePreviewDragOverCapture = useCallback(
    (e: React.DragEvent) => {
      if (readOnly || editMode !== 'wysiwyg') return;
      if (!canReadHuabuPayload(e.dataTransfer)) return;
      // We can't tell self-vs-cross-source until drop (dataTransfer
      // JSON is gated). preventDefault here unconditionally so the
      // browser permits the drop; the dropCapture handler does the
      // final routing. Self-source still benefits from the cursor
      // showing as a drop target.
      //
      // CRITICAL: do NOT stopPropagation here.
      // `prosemirror-drop-indicator` attaches its dragover listener
      // directly on `editorView.dom` and only renders the drop
      // indicator when it receives the event. Stopping propagation at
      // the outer capture phase suppresses that listener entirely —
      // the user sees no insertion indicator at all, and
      // `insertBlocksAtDropIndicator` has no position to use.
      // preventDefault alone is enough to keep the browser drop
      // allowed AND to flip `defaultPrevented` so PM's drop handler
      // bails (see the drop handler's own check).
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    [readOnly, editMode],
  );
  const handlePreviewDropCapture = useCallback(
    (e: React.DragEvent) => {
      if (readOnly || editMode !== 'wysiwyg') return;
      if (!canReadHuabuPayload(e.dataTransfer)) return;
      const payload = getHuabuPayload(e.dataTransfer);
      if (!payload) return;
      // Self-source (a block from this same note) → let Crepe's
      // bubble-phase in-editor reorder run. We must NOT
      // preventDefault or stopPropagation here.
      if (
        payload.kind === 'note' &&
        typeof payload.data.sourceNodeId === 'string' &&
        payload.data.sourceNodeId === id
      ) {
        return;
      }

      const snippet = dragPayloadToMarkdown(payload, { canvasId });
      if (!snippet) return;

      // Cross-source: claim the gesture. preventDefault flips the
      // native event's `defaultPrevented`, which ProseMirror's drop
      // handler checks and skips on. stopPropagation suppresses
      // further React handlers.
      e.preventDefault();
      e.stopPropagation();

      if (!editor) return;
      // Insert exactly where the blue bar is showing. Falls back to
      // appending when no bar was rendered (pointer never reached the
      // editor surface, e.g. the container's outer padding).
      if (!editor.insertBlocksAtDropIndicator(snippet)) {
        const keys = editor.getBlockKeys();
        editor.insertBlocksAfter(
          keys.length > 0 ? (keys[keys.length - 1] ?? null) : null,
          snippet,
        );
      }
      // The indicator only hides when it observes the drop / dragend /
      // dragleave on `view.dom`. Our capture-phase `stopPropagation`
      // above suppresses the drop event before it reaches the plugin,
      // AND the browser's follow-up `dragend` fires on the drag source
      // (a chat message / other note) which sits outside this editor —
      // so without an explicit nudge the blue bar would linger.
      editor.clearDropIndicator();
      // The editor's `onChange` fires synchronously after the insert
      // and patches `content` through `handleEditorChange`. Cross-note
      // MOVE (source patch) isn't applied here because only one note
      // can be expanded at a time — the cross-note flow happens via
      // dropping on the SOURCE-OTHER note's tile in `NoteNode`.
    },
    [readOnly, editMode, id, editor, canvasId],
  );

  const totalPending =
    provenance.blocks.length + provenance.deletedBlocks.length;
  // Compact single-line summary — collapse edited + deleted into one
  // count (e.g. "2 changes") to keep the chip narrow.
  const summaryLabel = t('node.pendingEdits', { count: totalPending });
  const showProvenanceChip =
    PROVENANCE_ENABLED &&
    !readOnly &&
    editMode === 'wysiwyg' &&
    totalPending > 0;

  // Host header slot — rendered by `ExpandedNodePanel`. When present
  // and the preview is editable, we portal the rich/raw toggle into
  // it so it sits next to the universal Split view / Close buttons
  // instead of floating over the editor content.
  const { el: headerSlotEl } = usePreviewHeaderSlot();
  const toggleButton = !readOnly ? (
    <Button
      variant="ghost"
      tone="neutral"
      size="sm"
      iconOnly
      className={
        editMode === 'raw'
          ? 'text-info bg-info-bg enabled:hover:bg-info-bg-hover'
          : ''
      }
      title={
        editMode === 'wysiwyg'
          ? t('node.editRawMarkdown')
          : t('node.editRichText')
      }
      tooltipPlacement="bottom"
      aria-label={
        editMode === 'wysiwyg'
          ? t('node.switchToRawMarkdown')
          : t('node.switchToRichText')
      }
      aria-pressed={editMode === 'raw'}
      onClick={() => setEditMode((m) => (m === 'wysiwyg' ? 'raw' : 'wysiwyg'))}
    >
      {editMode === 'wysiwyg' ? <Code2 /> : <FileText />}
    </Button>
  ) : null;

  return (
    <div className="bg-surface relative h-full w-full">
      {headerSlotEl && toggleButton
        ? createPortal(toggleButton, headerSlotEl)
        : null}

      <div
        ref={containerRef}
        className={`relative h-full w-full overflow-auto py-3 ${
          editMode === 'raw' ? 'px-3' : 'pr-3'
        }`}
        onDragOverCapture={handlePreviewDragOverCapture}
        onDropCapture={handlePreviewDropCapture}
      >
        {editMode === 'wysiwyg' ? (
          <>
            {!readOnly ? (
              <MilkdownFloatingToolbar
                instance={editor}
                surfaceRef={containerRef}
              />
            ) : null}
            <div className="contents" data-preview-search-content>
              <MilkdownEditor
                markdown={markdown}
                editable={!readOnly}
                canvasId={canvasId ?? undefined}
                onChange={handleEditorChange}
                onExternalUpdate={handleExternalUpdate}
                onReady={setEditor}
                onBlockDragStart={readOnly ? undefined : handleBlockDragStart}
                decorations={decorations}
                className="milkdown-note-preview"
              />
            </div>
            {PROVENANCE_ENABLED && !readOnly ? (
              <ProvenanceOverlay
                blocks={provenance.blocks}
                tombstones={provenance.deletedBlocks}
                editor={editor}
                containerRef={containerRef}
                onAcceptBlock={handleAcceptBlock}
                onRejectBlock={handleRejectBlock}
                onInsertBelow={handleInsertBelow}
                onRestoreTombstone={handleRestoreTombstone}
                onDismissTombstone={handleDismissTombstone}
              />
            ) : null}
          </>
        ) : (
          <div className="contents" data-preview-search-content>
            <Suspense
              fallback={
                <div className="text-fg-subtle px-2 py-1 text-xs">
                  {t('node.loadingSourceEditor')}
                </div>
              }
            >
              <RawMarkdownEditor
                value={markdown}
                readOnly={readOnly}
                onChange={handleRawChange}
                ariaLabel={t('node.rawMarkdownSource')}
                className="huabu-raw-markdown"
              />
            </Suspense>
          </div>
        )}
      </div>
      {showProvenanceChip ? (
        <div
          className="bg-surface absolute bottom-3 left-1/2 z-20 flex w-fit -translate-x-1/2 items-center gap-1.5 rounded-md py-1 pr-1 pl-2.5 whitespace-nowrap shadow-[0_0_14px_rgba(0,0,0,0.12)]"
          role="status"
          aria-label={t('node.aiPendingEditsAria', {
            count: totalPending,
          })}
        >
          <Sparkles className="text-ai size-3.5 shrink-0" />
          <span className="text-fg-muted text-xs">{summaryLabel}</span>
          <span aria-hidden className="bg-edge-default mx-0.5 h-4 w-px" />
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            onClick={handleRejectAll}
            title={t('node.restoreAllBlocks')}
          >
            {t('node.reject')}
          </Button>
          <Button
            variant="solid"
            tone="info"
            size="sm"
            onClick={handleAcceptAll}
            title={t('node.keepAllAiChanges')}
          >
            {t('node.accept')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
