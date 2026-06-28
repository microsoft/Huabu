/**
 * Milkdown-backed note preview.
 *
 * Implements the `PreviewComponentProps` contract shared by every
 * preview surface so the rest of the canvas / agent stack treats notes
 * uniformly.
 *
 * Block provenance: when the AI updates `data.content` externally,
 * MilkdownEditor surfaces before/after fingerprint snapshots via
 * `onExternalUpdate`. We diff and `stampAiEdit` once at stream-end
 * (Approach B) — per-chunk stamping is intentionally not supported.
 * User edits clear markers organically via `shiftProvenance`. Accept
 * / Reject / Restore / Dismiss UI is rendered by `<ProvenanceOverlay>`.
 *
 * Set `VITE_PROVENANCE=off` in `.env` to disable Phase 4 entirely
 * (decoration-less, overlay-less editor — useful for bisecting bugs
 * during iteration).
 */

import { Code2, FileText } from 'lucide-react';
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

import { Button } from '@/components/Common/Button';
import { MilkdownEditor } from '@/components/Milkdown';
import { usePreviewHeaderSlot } from '@/components/Nodes/PreviewHeaderSlot';
import useCanvasStore from '@/store/canvasStore';
import { consumeAiContentEdit } from '@/utils/aiEditFlags';
import {
  coerceProvenance,
  dismissDeletedBlock,
  dropBlockEntry,
  emptyProvenance,
  shiftProvenance,
  stampAiEdit,
} from '@/utils/blockProvenance';
import {
  canReadSedimentPayload,
  getSedimentPayload,
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
import type { MarkdownProvenance, NodeOrigin } from '@sediment/shared';

const PROVENANCE_ENABLED = (import.meta.env.VITE_PROVENANCE ?? 'on') !== 'off';

const AI_BLOCK_CLASSNAME = 'sediment-ai-edited-block';

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
  data: Record<string, unknown>;
  readOnly?: boolean;
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
  data,
  readOnly,
  onContentChange,
  onDataChange,
}: PreviewComponentProps) => {
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
    ({ oldKeys, newKeys, oldMarkdownByKey, newMarkdownByKey }) => {
      // Consume the per-node attribution flag unconditionally so it
      // does not leak across updates (e.g. when provenance is
      // disabled or when the keys-equal early-out short-circuits).
      const aiAuthored = id ? consumeAiContentEdit(id) : false;
      if (!PROVENANCE_ENABLED) return;
      // Pure key-equal => nothing to do (e.g. content normalized
      // round-trip with no actual block change).
      if (
        oldKeys.length === newKeys.length &&
        oldKeys.every((k, i) => k === newKeys[i])
      ) {
        return;
      }
      if (!aiAuthored) {
        // External update from a non-AI source — typically another
        // panel rendering the same node and echoing the user's edit
        // through the data prop. Realign existing markers against the
        // new doc shape so they stay attached to live blocks, but do
        // NOT stamp new AI markers.
        const shifted = shiftProvenance(provenanceRef.current, newKeys);
        if (
          shifted.blocks.length !== provenanceRef.current.blocks.length ||
          shifted.deletedBlocks.length !==
            provenanceRef.current.deletedBlocks.length
        ) {
          provenanceRef.current = shifted;
          writePatch({ provenance: shifted });
        }
        return;
      }
      const next = stampAiEdit(provenanceRef.current, {
        oldKeys,
        newKeys,
        oldMarkdownByKey,
        newMarkdownByKey,
      });
      provenanceRef.current = next;
      writePatch({ provenance: next });
    },
    [id, writePatch],
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

  // Auto-focus the editor whenever the user triggers "expand this
  // node" — covering both the first mount (e.g., double-click an
  // unopened note) AND a repeat double-click on the already-expanded
  // node. We drive this off `expandedNodeFocusTick`, a store counter
  // bumped by every `openExpanded` call. The ref-tracked
  // `lastHandledTickRef` skips redundant focuses on unrelated effect
  // runs (e.g., toggling raw ↔ wysiwyg) so we never steal focus from
  // an input elsewhere on the page when no expansion was requested.
  // The sentinel `-1` guarantees the first valid run (editor ready,
  // editable, wysiwyg) always focuses even on a fresh mount.
  const focusTick = useCanvasStore((s) => s.expandedNodeFocusTick);
  // Needed to resolve artifact-key image srcs (e.g. `art_xxx.png`)
  // dragged in from chat so the inserted markdown carries a
  // fetchable HTTP URL rather than a bare key the renderer can't
  // dereference.
  const canvasId = useCanvasStore((s) => s.canvasId);
  const lastHandledFocusTickRef = useRef<number>(-1);
  useEffect(() => {
    if (!editor) return;
    if (readOnly) return;
    if (editMode !== 'wysiwyg') return;
    if (lastHandledFocusTickRef.current === focusTick) return;
    lastHandledFocusTickRef.current = focusTick;
    editor.focus();
  }, [editor, readOnly, editMode, focusTick]);

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
        effectAllowed: 'copyMove',
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

  // ── Drop target: external Sediment payloads (chat messages, image
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
      if (!canReadSedimentPayload(e.dataTransfer)) return;
      // We can't tell self-vs-cross-source until drop (dataTransfer
      // JSON is gated). preventDefault here unconditionally so the
      // browser permits the drop; the dropCapture handler does the
      // final routing. Self-source still benefits from the cursor
      // showing as a drop target.
      //
      // CRITICAL: do NOT stopPropagation here. ProseMirror's
      // `prosemirror-dropcursor` plugin attaches its dragover
      // listener directly on `editorView.dom` in the BUBBLE phase
      // and only renders the drop indicator when it receives the
      // event. Stopping propagation at the outer capture phase
      // suppresses that listener entirely — the user sees no
      // insertion indicator at all. preventDefault alone is enough
      // to keep the browser drop allowed AND to flip
      // `defaultPrevented` so PM's drop handler bails (see the drop
      // handler's own check).
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    [readOnly, editMode],
  );
  const handlePreviewDropCapture = useCallback(
    (e: React.DragEvent) => {
      if (readOnly || editMode !== 'wysiwyg') return;
      if (!canReadSedimentPayload(e.dataTransfer)) return;
      const payload = getSedimentPayload(e.dataTransfer);
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

      const snippet = dragPayloadToMarkdown(payload, {
        ...(canvasId ? { canvasId } : {}),
      });
      if (!snippet) return;

      // Cross-source: claim the gesture. preventDefault flips the
      // native event's `defaultPrevented`, which ProseMirror's drop
      // handler checks and skips on. stopPropagation suppresses
      // further React handlers.
      e.preventDefault();
      e.stopPropagation();

      if (!editor) return;
      const anchorKey = editor.getBlockKeyAtPoint(e.clientX, e.clientY);
      // `getBlockKeyAtPoint` returns:
      //   string    — anchor on this block (insert AFTER it)
      //   null      — insert at doc head (the gap above the first
      //               block was the visible drop target)
      //   undefined — the drop landed outside the editor surface
      //               (top / bottom padding); append to the last block.
      let resolvedAnchor: string | null;
      if (anchorKey === undefined) {
        const keys = editor.getBlockKeys();
        resolvedAnchor = keys.length > 0 ? keys[keys.length - 1] : null;
      } else {
        resolvedAnchor = anchorKey;
      }
      editor.insertBlocksAfter(resolvedAnchor, snippet);
      // PM's `dropcursor` only clears the bar when it observes the
      // drop / dragend / out-of-editor dragleave on `view.dom`. Our
      // capture-phase `stopPropagation` above suppresses the drop
      // event before it reaches PM, AND the browser's follow-up
      // `dragend` fires on the drag source (a chat message / other
      // note) which sits outside this editor — so without an
      // explicit nudge the blue bar would linger until PM's 5s
      // safety timeout.
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
      title={editMode === 'wysiwyg' ? 'Edit raw markdown' : 'Edit rich text'}
      tooltipPlacement="bottom"
      aria-label={
        editMode === 'wysiwyg'
          ? 'Switch to raw markdown editor'
          : 'Switch to rich text editor'
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
            <MilkdownEditor
              markdown={markdown}
              editable={!readOnly}
              onChange={handleEditorChange}
              onExternalUpdate={handleExternalUpdate}
              onReady={setEditor}
              onBlockDragStart={readOnly ? undefined : handleBlockDragStart}
              decorations={decorations}
              className="milkdown-note-preview"
            />
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
          <Suspense
            fallback={
              <div className="text-fg-subtle px-2 py-1 text-xs">
                Loading source editor…
              </div>
            }
          >
            <RawMarkdownEditor
              value={markdown}
              readOnly={readOnly}
              onChange={handleRawChange}
              ariaLabel="Raw markdown source"
              className="sediment-raw-markdown"
            />
          </Suspense>
        )}
      </div>
      {showProvenanceChip ? (
        <div
          className="border-edge-default bg-surface absolute bottom-3 left-1/2 z-20 flex w-fit -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1 shadow-lg"
          role="status"
          aria-label={`AI made ${totalPending} pending edit${totalPending === 1 ? '' : 's'} on this note`}
        >
          <span className="text-fg-muted text-xs">
            {`AI edited ${provenance.blocks.length} block${provenance.blocks.length === 1 ? '' : 's'}`}
            {provenance.deletedBlocks.length > 0
              ? ` · deleted ${provenance.deletedBlocks.length}`
              : ''}
          </span>
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={handleRejectAll}
            title="Restore all blocks to their pre-AI baseline"
          >
            Reject
          </Button>
          <Button
            variant="solid"
            tone="info"
            size="sm"
            onClick={handleAcceptAll}
            title="Keep all AI changes and clear the markers"
          >
            Accept
          </Button>
        </div>
      ) : null}
    </div>
  );
};
