/**
 * Milkdown-backed note preview.
 *
 * Replaces the legacy BlockNote implementation. The contract with the
 * sibling preview components (`PreviewComponentProps`) is unchanged so
 * the rest of the canvas / agent stack continues to work without
 * modification.
 *
 * Phase 4 (block provenance): when the AI updates `data.content`
 * externally, MilkdownEditor surfaces before/after fingerprint
 * snapshots via `onExternalUpdate`. We diff and `stampAiEdit` once at
 * stream-end (Approach B) — per-chunk stamping is intentionally not
 * supported. User edits clear markers organically via
 * `shiftProvenance`. Accept / Reject / Restore / Dismiss UI is rendered
 * by `<ProvenanceOverlay>`.
 *
 * Set `VITE_PROVENANCE=off` in `.env` to disable Phase 4 entirely
 * (decoration-less, overlay-less editor — useful for bisecting bugs
 * during iteration).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MilkdownEditor } from '@/components/Milkdown';
import {
  acceptBlock,
  coerceProvenance,
  dismissDeletedBlock,
  emptyProvenance,
  shiftProvenance,
  stampAiEdit,
} from '@/utils/blockProvenance';
import { setDragPayload } from '@/utils/io/dragDrop';

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
      if (!PROVENANCE_ENABLED) return;
      // Pure key-equal => nothing to stamp (e.g. content normalized
      // round-trip with no actual block change).
      if (
        oldKeys.length === newKeys.length &&
        oldKeys.every((k, i) => k === newKeys[i])
      ) {
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
      const next = acceptBlock(provenanceRef.current, key);
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
      const next = acceptBlock(provenanceRef.current, key);
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
      const next = acceptBlock(provenanceRef.current, key);
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

  // Push an extra decoration sync when the editor instance becomes
  // available (the prop-driven effect inside MilkdownEditor only fires
  // on subsequent prop changes — not on initial mount when decorations
  // were already known).
  useEffect(() => {
    if (!editor) return;
    editor.setBlockDecorations(decorations?.blocks ?? []);
  }, [editor, decorations]);

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
          data: { content: trimmed },
        };

      setDragPayload(event.nativeEvent as unknown as React.DragEvent, payload);
    },
    [id],
  );

  return (
    <div className="bg-surface relative h-full w-full">
      <div
        ref={containerRef}
        className="custom-scrollbar relative h-full w-full overflow-auto py-3 pr-3"
      >
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
      </div>
    </div>
  );
};
