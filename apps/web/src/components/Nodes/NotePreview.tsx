import { SideMenuController, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { loadBlockNoteContent } from '@/components/BlockNote/blockNoteContent';
import {
  NoteEditorSideMenu,
  NoteSourceIdProvider,
} from '@/components/BlockNote/NoteEditorSideMenu';
import { blockNoteShadcnOverrides } from '@/components/BlockNote/shadcnOverrides';
import { Button } from '@/components/Common/Button';
import {
  clearAllBaselines,
  clearBaselineText,
  deriveBlockDiffMap,
  deriveDeletedBlocks,
  extractBlockText,
  getBlockAuthorStatus,
  getDeletedKeys,
  hasAnyPendingDiff,
  recordUserEdits,
  removeDeletedEntry,
  repairDeletedBlockAnchors,
  resolveSentinelProvenance,
} from '@/utils/provenance';

import { InlineBlockDiffs } from './InlineBlockDiffs';

import type { DeletedBlockInfo, ProvenanceBlock } from '@/utils/provenance';
import type { BlockProvenanceMap } from '@sediment/shared';

export interface PreviewComponentProps {
  data: Record<string, unknown>;
  readOnly?: boolean;
  /** Called with a plain string for backward-compat consumers. */
  onContentChange?: (newContent: string) => void;
  /**
   * Preferred over `onContentChange` when available.
   * Receives a patch with `content` (Markdown) and `contentJson` (BlockNote JSON).
   */
  onDataChange?: (patch: Record<string, unknown>) => void;
}

/** Extract an auto-title from a BlockNote document. Prefers H1, then any heading, then the first non-empty block text. */
export const NotePreview = ({
  data,
  readOnly,
  onContentChange,
  onDataChange,
}: PreviewComponentProps) => {
  // `content` is the canonical Markdown string.
  // `contentJson` is the auxiliary BlockNote JSON (lossless, editor-internal).
  // `contentJsonSource` is the `content` value at the time `contentJson` was
  // generated — used to detect external edits (e.g. by the AI agent) without
  // relying on the lossy `blocksToMarkdownLossy` round-trip.
  const markdown = typeof data.content === 'string' ? data.content : '';
  const contentJson =
    typeof data.contentJson === 'string' ? data.contentJson : null;
  const contentJsonSource =
    typeof data.contentJsonSource === 'string' ? data.contentJsonSource : null;

  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
    trailingBlock: false,
  });

  // Track the last Markdown we applied so we can skip no-op updates.
  const lastAppliedMarkdownRef = useRef<string | null>(null);
  // Track the last document JSON to detect whether onChange was triggered
  // by an actual content change vs cursor movement / focus / editable toggle.
  const lastDocJsonRef = useRef<string>('');

  // Disable editing while async content is being loaded to prevent the editor
  // from accepting input that would immediately be overwritten by replaceBlocks.
  const [loading, setLoading] = useState(true);
  // Synchronous ref companion — `loading` state is batched and may be stale in
  // the onChange closure, so use this ref to reliably suppress provenance
  // tracking while replaceBlocks is running.
  const isReplacingRef = useRef(false);

  // Block-level provenance tracking
  const provenanceRef = useRef<BlockProvenanceMap | undefined>(
    data.provenance as BlockProvenanceMap | undefined,
  );
  const [provenance, setProvenance] = useState<BlockProvenanceMap | undefined>(
    provenanceRef.current,
  );
  // Track which block IDs existed before the last change, to detect new/modified blocks.
  // Stored as an ordered array so we can find positional predecessors when repairing
  // stale afterBlockId references in __deleted_* entries.
  const prevBlockIdsRef = useRef<string[]>([]);

  // Stores the last fully-expanded (per-block) provenance so that it survives
  // external updates that overwrite provenanceRef with a sentinel map.
  const lastExpandedProvenanceRef = useRef<BlockProvenanceMap | undefined>(
    undefined,
  );

  // Sync provenance state when external data.provenance changes (e.g. AI updates)
  const externalProvenance = data.provenance as BlockProvenanceMap | undefined;
  useEffect(() => {
    if (externalProvenance === provenanceRef.current) return;
    provenanceRef.current = externalProvenance;
    setProvenance(externalProvenance);
  }, [externalProvenance]);

  // Ref to the scrollable editor container for DOM queries by InlineBlockDiffs
  const editorContainerRef = useRef<HTMLDivElement>(null);

  // Per-block diff map and deleted blocks — derived from provenance.
  const [blockDiffMap, setBlockDiffMap] = useState<Map<string, string>>(
    new Map(),
  );
  const [deletedBlocks, setDeletedBlocks] = useState<DeletedBlockInfo[]>([]);

  // Debounced persistence timer for onChange — serialisation + writePatch are
  // deferred so provenance state updates stay immediate while expensive work
  // (blocksToMarkdownLossy, JSON stringify for the patch) batches naturally.
  const persistTimerRef = useRef(0);

  /** Write a content patch back to the parent. */
  const writePatch = (
    newMarkdown: string,
    newJson: string,
    provenancePatch?: BlockProvenanceMap,
    extraPatch?: Record<string, unknown>,
  ) => {
    const patch: Record<string, unknown> = {
      content: newMarkdown,
      contentJson: newJson,
      // Record which markdown string this JSON was derived from so we can
      // detect external edits on next open without a lossy round-trip.
      contentJsonSource: newMarkdown,
      ...extraPatch,
    };
    if (provenancePatch !== undefined) {
      patch.provenance = provenancePatch;
    }
    if (onDataChange) {
      onDataChange(patch);
    } else if (onContentChange) {
      onContentChange(newMarkdown);
    }
  };

  useEffect(() => {
    if (lastAppliedMarkdownRef.current === markdown) return;

    lastAppliedMarkdownRef.current = markdown;
    setLoading(true);

    void (async () => {
      try {
        // Snapshot old blocks before replacement for provenance diffing.
        const oldBlocksFromEditor = editor.document.map(
          (b: {
            id: string;
            type: string;
            content?: unknown;
            children?: unknown;
          }) => ({
            id: b.id,
            type: b.type,
            content: b.content,
            children: b.children,
          }),
        );

        isReplacingRef.current = true;
        const usedJson = await loadBlockNoteContent(
          editor,
          markdown,
          contentJson,
          contentJsonSource,
        );
        isReplacingRef.current = false;

        // Snapshot the document JSON so onChange can detect whether content
        // actually changed vs mere cursor/focus events.
        lastDocJsonRef.current = JSON.stringify(editor.document);

        const rawProvenance = data.provenance as BlockProvenanceMap | undefined;
        const newBlocks = editor.document.map(
          (b: {
            id: string;
            type: string;
            content?: unknown;
            children?: unknown;
          }) => ({
            id: b.id,
            type: b.type,
            content: b.content,
            children: b.children,
          }),
        );

        const resolved = resolveSentinelProvenance(rawProvenance, {
          fallbackOldProvenance: lastExpandedProvenanceRef.current,
          newBlocks,
          oldBlocksFromEditor,
          contentJson,
        });

        let effectiveProvenance: BlockProvenanceMap | undefined;
        if (resolved && resolved !== rawProvenance) {
          effectiveProvenance = resolved;
          provenanceRef.current = resolved;
          setProvenance(resolved);
          lastExpandedProvenanceRef.current = resolved;
          if (!readOnly && onDataChange) {
            // Clear legacy contentBeforeAI during migration
            const migrationPatch: Record<string, unknown> = {
              provenance: resolved,
            };
            if (typeof data.contentBeforeAI === 'string') {
              migrationPatch.contentBeforeAI = undefined;
            }
            onDataChange(migrationPatch);
          }
        } else {
          effectiveProvenance = rawProvenance;
          provenanceRef.current = rawProvenance;
          setProvenance(rawProvenance);
          if (
            rawProvenance &&
            !('__all__' in rawProvenance) &&
            Object.keys(rawProvenance).length > 0
          ) {
            lastExpandedProvenanceRef.current = rawProvenance;
          }
        }

        prevBlockIdsRef.current = newBlocks.map((b) => b.id);

        if (!usedJson && !readOnly) {
          const newJson = JSON.stringify(editor.document);
          writePatch(markdown, newJson, resolved ?? rawProvenance);
        }

        // Derive diff map and deleted blocks directly from provenance.
        setBlockDiffMap(deriveBlockDiffMap(effectiveProvenance));
        setDeletedBlocks(deriveDeletedBlocks(effectiveProvenance));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, contentJson, editor]);

  // Expand __all__ sentinel after editor loads, even when the content-load
  // effect skipped (e.g. markdown was already applied on a previous mount).
  useEffect(() => {
    if (loading) return;
    const current = provenanceRef.current;
    if (!current || !('__all__' in current)) return;

    const currentBlocks = editor.document.map(
      (b: {
        id: string;
        type: string;
        content?: unknown;
        children?: unknown;
      }) => ({
        id: b.id,
        type: b.type,
        content: b.content,
        children: b.children,
      }),
    );

    const expanded = resolveSentinelProvenance(current, {
      newBlocks: currentBlocks,
      oldBlocksFromEditor: currentBlocks,
      contentJson,
    });

    if (expanded && expanded !== current) {
      provenanceRef.current = expanded;
      setProvenance(expanded);
      lastExpandedProvenanceRef.current = expanded;
      if (!readOnly && onDataChange) {
        onDataChange({ provenance: expanded });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Generate dynamic CSS rules for per-block provenance color bars.
  // Deep purple = AI block with pending diff; light purple = AI block accepted / no changes.
  const provenanceCss = useMemo(() => {
    if (!provenance) return '';
    const rules: string[] = [];
    for (const [blockId, entry] of Object.entries(provenance)) {
      if (blockId === '__all__' || blockId.startsWith('__deleted_')) continue;
      const safeId = blockId.replace(/[^a-zA-Z0-9_-]/g, '');
      const status = getBlockAuthorStatus(entry);
      const hasDiff = blockDiffMap.has(blockId);
      if (status === 'ai') {
        const color = hasDiff ? 'var(--color-ai)' : 'var(--color-ai-light)';
        rules.push(
          `.bn-block[data-id="${safeId}"] { position: relative; padding-right: 8px; }`,
        );
        rules.push(
          `.bn-block[data-id="${safeId}"]::before { content: ''; position: absolute; top: 0; right: -12px; bottom: 0; width: 6px; background: ${color}; border-radius: 1px; }`,
        );
        if (hasDiff) {
          rules.push(
            `.bn-block[data-id="${safeId}"]::after { content: ''; position: absolute; top: 0; right: -22px; width: 20px; height: 100%; cursor: pointer; }`,
          );
        }
      }
    }
    return rules.join('\n');
  }, [provenance, blockDiffMap]);

  // --- Accept / Reject callbacks ---

  const handleAcceptAll = useCallback(() => {
    const cleared = clearAllBaselines(provenanceRef.current);
    provenanceRef.current = cleared;
    setProvenance(cleared);
    setBlockDiffMap(new Map());
    setDeletedBlocks([]);
    onDataChange?.({ provenance: cleared });
  }, [onDataChange]);

  const handleRejectAll = useCallback(() => {
    const prov = provenanceRef.current;
    if (!prov) return;

    // Restore each block to its baselineText
    for (const [blockId, entry] of Object.entries(prov)) {
      if (blockId.startsWith('__deleted_') || blockId === '__all__') continue;
      if (entry.baselineText === undefined) continue;
      try {
        if (entry.baselineText === '') {
          // Block was added by AI — remove it
          editor.removeBlocks([blockId]);
        } else {
          editor.updateBlock(blockId, { content: entry.baselineText });
        }
      } catch {
        // Block may not exist in editor
      }
    }

    // Re-insert deleted blocks
    for (const [key, entry] of Object.entries(prov)) {
      if (!key.startsWith('__deleted_') || !entry.baselineText) continue;
      try {
        if (entry.afterBlockId) {
          editor.insertBlocks(
            [{ type: 'paragraph', content: entry.baselineText }],
            entry.afterBlockId,
            'after',
          );
        } else {
          const first = editor.document[0];
          if (first) {
            editor.insertBlocks(
              [{ type: 'paragraph', content: entry.baselineText }],
              first.id,
              'before',
            );
          }
        }
      } catch {
        // Anchor block may not exist
      }
    }

    // Clear all baselines and persist
    const cleared = clearAllBaselines(prov);
    provenanceRef.current = cleared;
    setProvenance(cleared);
    setBlockDiffMap(new Map());
    setDeletedBlocks([]);

    const md = editor.blocksToMarkdownLossy(editor.document);
    const json = JSON.stringify(editor.document);
    lastAppliedMarkdownRef.current = md.trim();
    lastDocJsonRef.current = json;
    writePatch(md.trim(), json, cleared);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, onDataChange]);

  const handleAcceptBlock = useCallback(
    (blockId: string) => {
      const updated = clearBaselineText(provenanceRef.current, blockId);
      provenanceRef.current = updated;
      setProvenance(updated);

      const newDiffMap = deriveBlockDiffMap(updated);
      const newDeletedBlocks = deriveDeletedBlocks(updated);
      setBlockDiffMap(newDiffMap);
      setDeletedBlocks(newDeletedBlocks);
      onDataChange?.({ provenance: updated });
    },
    [onDataChange],
  );

  const handleRejectBlock = useCallback(
    (blockId: string) => {
      const entry = provenanceRef.current?.[blockId];
      if (entry?.baselineText === undefined) return;

      try {
        if (entry.baselineText === '') {
          // Block was added by AI — remove it
          editor.removeBlocks([blockId]);
        } else {
          editor.updateBlock(blockId, { content: entry.baselineText });
        }
      } catch {
        return;
      }

      let updated = recordUserEdits(provenanceRef.current, [blockId]);
      updated = clearBaselineText(updated, blockId);
      provenanceRef.current = updated;
      setProvenance(updated);

      setBlockDiffMap(deriveBlockDiffMap(updated));
      setDeletedBlocks(deriveDeletedBlocks(updated));

      const md = editor.blocksToMarkdownLossy(editor.document);
      const json = JSON.stringify(editor.document);
      lastAppliedMarkdownRef.current = md.trim();
      lastDocJsonRef.current = json;
      writePatch(md.trim(), json, updated);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  );

  const handleAcceptDeletedBlock = useCallback(
    (index: number) => {
      const keys = getDeletedKeys(provenanceRef.current);
      const key = keys[index];
      if (!key) return;

      const updated = removeDeletedEntry(provenanceRef.current, key);
      provenanceRef.current = updated;
      setProvenance(updated);
      setBlockDiffMap(deriveBlockDiffMap(updated));
      setDeletedBlocks(deriveDeletedBlocks(updated));
      onDataChange?.({ provenance: updated });
    },
    [onDataChange],
  );

  const handleRestoreBlock = useCallback(
    (index: number) => {
      const keys = getDeletedKeys(provenanceRef.current);
      const key = keys[index];
      const entry = provenanceRef.current?.[key];
      if (!key || !entry?.baselineText) return;

      try {
        if (entry.afterBlockId) {
          editor.insertBlocks(
            [{ type: 'paragraph', content: entry.baselineText }],
            entry.afterBlockId,
            'after',
          );
        } else {
          const firstBlock = editor.document[0];
          if (firstBlock) {
            editor.insertBlocks(
              [{ type: 'paragraph', content: entry.baselineText }],
              firstBlock.id,
              'before',
            );
          }
        }
      } catch {
        return;
      }

      const updated = removeDeletedEntry(provenanceRef.current, key);
      provenanceRef.current = updated;
      setProvenance(updated);
      setBlockDiffMap(deriveBlockDiffMap(updated));
      setDeletedBlocks(deriveDeletedBlocks(updated));

      const md = editor.blocksToMarkdownLossy(editor.document);
      const json = JSON.stringify(editor.document);
      lastAppliedMarkdownRef.current = md.trim();
      lastDocJsonRef.current = json;
      writePatch(md.trim(), json, updated);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  );

  const getBlockText = useCallback(
    (blockId: string): string => {
      const block = editor.document.find(
        (b: { id: string }) => b.id === blockId,
      );
      if (!block) return '';
      return extractBlockText(block as ProvenanceBlock);
    },
    [editor],
  );

  const handleInsertBelow = useCallback(
    (blockId: string) => {
      const entry = provenanceRef.current?.[blockId];
      if (entry?.baselineText === undefined) return;

      // AI-added block (no prior content) — treat as accept
      if (entry.baselineText === '') {
        const updated = clearBaselineText(provenanceRef.current, blockId);
        provenanceRef.current = updated;
        setProvenance(updated);
        setBlockDiffMap(deriveBlockDiffMap(updated));
        setDeletedBlocks(deriveDeletedBlocks(updated));
        onDataChange?.({ provenance: updated });
        return;
      }

      // Capture the current AI text before restoring
      const aiText = getBlockText(blockId);

      try {
        // Restore the block to the user's original content
        editor.updateBlock(blockId, { content: entry.baselineText });
        // Insert the AI content as a new block below
        const inserted = editor.insertBlocks(
          [{ type: 'paragraph', content: aiText }],
          blockId,
          'after',
        );
        const insertedId = inserted[0]?.id;

        // Update provenance for the original block (same as reject)
        let updated = recordUserEdits(provenanceRef.current, [blockId]);
        updated = clearBaselineText(updated, blockId);

        // Stamp provenance for the new AI block
        if (insertedId) {
          updated = {
            ...updated,
            [insertedId]: {
              author: 'ai' as const,
              createdAt: new Date().toISOString(),
            },
          };
        }

        provenanceRef.current = updated;
        setProvenance(updated);
        setBlockDiffMap(deriveBlockDiffMap(updated));
        setDeletedBlocks(deriveDeletedBlocks(updated));

        const md = editor.blocksToMarkdownLossy(editor.document);
        const json = JSON.stringify(editor.document);
        lastAppliedMarkdownRef.current = md.trim();
        lastDocJsonRef.current = json;
        // Sync prevBlockIdsRef so onChange doesn't treat the inserted block as new
        prevBlockIdsRef.current = editor.document.map(
          (b: { id: string }) => b.id,
        );
        writePatch(md.trim(), json, undefined, updated);
      } catch {
        return;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, getBlockText],
  );

  return (
    <div className="relative h-full w-full">
      <div
        ref={editorContainerRef}
        className="custom-scrollbar relative h-full w-full overflow-auto bg-white py-3"
      >
        {provenanceCss && <style>{provenanceCss}</style>}
        <NoteSourceIdProvider
          value={typeof data.sourceId === 'string' ? data.sourceId : undefined}
        >
          <BlockNoteView
            className="block-note-view"
            editor={editor}
            editable={!readOnly && !loading}
            shadCNComponents={blockNoteShadcnOverrides}
            sideMenu={false}
            onChange={() => {
              if (readOnly) return;
              if (!onContentChange && !onDataChange) return;
              if (isReplacingRef.current) return;

              const newJson = JSON.stringify(editor.document);

              if (newJson === lastDocJsonRef.current) return;
              lastDocJsonRef.current = newJson;

              const currentBlockIds = editor.document.map(
                (b: { id: string }) => b.id,
              );
              const prevIdSet = new Set(prevBlockIdsRef.current);

              // Collect all block IDs that need user-edit recording,
              // then apply in one batch to avoid repeated shallow copies.
              const editedBlockIds: string[] = [];
              for (const blockId of currentBlockIds) {
                if (!prevIdSet.has(blockId)) {
                  editedBlockIds.push(blockId);
                }
              }
              const cursorBlock = editor.getTextCursorPosition()?.block;
              if (cursorBlock && prevIdSet.has(cursorBlock.id)) {
                editedBlockIds.push(cursorBlock.id);
              }

              let updatedProvenance = recordUserEdits(
                provenanceRef.current,
                editedBlockIds,
              );

              if (cursorBlock && prevIdSet.has(cursorBlock.id)) {
                // Clear baselineText when user edits a block
                if (
                  updatedProvenance?.[cursorBlock.id]?.baselineText !==
                  undefined
                ) {
                  updatedProvenance = clearBaselineText(
                    updatedProvenance,
                    cursorBlock.id,
                  );
                }
              }

              if (updatedProvenance) {
                const currentIdSet = new Set(currentBlockIds);
                const cleaned = { ...updatedProvenance };
                let didClean = false;
                for (const key of Object.keys(cleaned)) {
                  if (
                    key !== '__all__' &&
                    !key.startsWith('__deleted_') &&
                    !currentIdSet.has(key)
                  ) {
                    delete cleaned[key];
                    didClean = true;
                  }
                }
                if (didClean) updatedProvenance = cleaned;

                // Repair __deleted_* entries whose afterBlockId is stale
                // (the anchor block was removed/merged by the user).
                updatedProvenance =
                  repairDeletedBlockAnchors(
                    updatedProvenance,
                    currentIdSet,
                    prevBlockIdsRef.current,
                  ) ?? updatedProvenance;
              }

              provenanceRef.current = updatedProvenance;
              setProvenance(updatedProvenance);
              lastExpandedProvenanceRef.current = updatedProvenance;
              prevBlockIdsRef.current = currentBlockIds;

              // Re-derive diffs from updated provenance
              setBlockDiffMap(deriveBlockDiffMap(updatedProvenance));
              setDeletedBlocks(deriveDeletedBlocks(updatedProvenance));

              // Debounce the expensive serialisation + persistence path.
              // Provenance state is already updated above for immediate UI.
              clearTimeout(persistTimerRef.current);
              persistTimerRef.current = window.setTimeout(() => {
                const md = editor.blocksToMarkdownLossy(editor.document);
                const newMarkdown = md.trim();
                lastAppliedMarkdownRef.current = newMarkdown;

                const latestJson = JSON.stringify(editor.document);
                lastDocJsonRef.current = latestJson;

                writePatch(newMarkdown, latestJson, provenanceRef.current);
              }, 150);
            }}
          >
            {!readOnly && <SideMenuController sideMenu={NoteEditorSideMenu} />}
          </BlockNoteView>
        </NoteSourceIdProvider>
        {!readOnly && (blockDiffMap.size > 0 || deletedBlocks.length > 0) && (
          <InlineBlockDiffs
            blockDiffMap={blockDiffMap}
            deletedBlocks={deletedBlocks}
            orderedBlockIds={editor.document.map((b: { id: string }) => b.id)}
            editorContainerRef={editorContainerRef}
            getBlockText={getBlockText}
            onAcceptBlock={handleAcceptBlock}
            onRejectBlock={handleRejectBlock}
            onInsertBelow={handleInsertBelow}
            onAcceptDeletedBlock={handleAcceptDeletedBlock}
            onRestoreBlock={handleRestoreBlock}
          />
        )}
      </div>
      {!readOnly && hasAnyPendingDiff(provenance) && (
        <div className="absolute right-4 bottom-4 flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={handleRejectAll}>
            Reject All
          </Button>
          <Button variant="primary" size="sm" onClick={handleAcceptAll}>
            Accept All
          </Button>
        </div>
      )}
    </div>
  );
};
