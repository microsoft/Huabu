import { SideMenuController, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useEffect, useMemo, useRef, useState } from 'react';

import { loadBlockNoteContent } from '@/components/BlockNote/blockNoteContent';
import {
  NoteEditorSideMenu,
  NoteSourceIdProvider,
} from '@/components/BlockNote/NoteEditorSideMenu';
import { blockNoteShadcnOverrides } from '@/components/BlockNote/shadcnOverrides';
import {
  expandSentinelProvenance,
  getBlockAuthorStatus,
  recordUserEdit,
} from '@/utils/provenance';

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
const extractLabelFromBlocks = (
  blocks: Array<{
    type: string;
    props?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }> | unknown;
  }>,
): string => {
  const getBlockText = (block: {
    content?: Array<{ type: string; text?: string }> | unknown;
  }) => {
    if (!Array.isArray(block.content)) return '';
    return block.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('');
  };

  const h1 = blocks.find((b) => b.type === 'heading' && b.props?.level === 1);
  const anyHeading = blocks.find((b) => b.type === 'heading');
  const firstNonEmpty = blocks.find((b) => getBlockText(b).trim().length > 0);

  const target = h1 ?? anyHeading ?? firstNonEmpty;
  if (!target) return '';
  return getBlockText(target).trim().slice(0, 50);
};

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

  // Disable editing while async content is being loaded to prevent the editor
  // from accepting input that would immediately be overwritten by replaceBlocks.
  const [loading, setLoading] = useState(true);

  // Block-level provenance tracking
  const provenanceRef = useRef<BlockProvenanceMap | undefined>(
    data.provenance as BlockProvenanceMap | undefined,
  );
  const [provenance, setProvenance] = useState<BlockProvenanceMap | undefined>(
    provenanceRef.current,
  );
  // Track which block IDs existed before the last change, to detect new/modified blocks
  const prevBlockIdsRef = useRef<Set<string>>(new Set());

  // Sync provenance state when external data.provenance changes (e.g. AI updates)
  const externalProvenance = data.provenance as BlockProvenanceMap | undefined;
  useEffect(() => {
    if (externalProvenance === provenanceRef.current) return;
    provenanceRef.current = externalProvenance;
    setProvenance(externalProvenance);
  }, [externalProvenance]);

  /** Write a content patch back to the parent. */
  const writePatch = (
    newMarkdown: string,
    newJson: string,
    autoLabel?: string,
    provenancePatch?: BlockProvenanceMap,
  ) => {
    const patch: Record<string, unknown> = {
      content: newMarkdown,
      contentJson: newJson,
      // Record which markdown string this JSON was derived from so we can
      // detect external edits on next open without a lossy round-trip.
      contentJsonSource: newMarkdown,
    };
    if (autoLabel !== undefined) {
      patch.label = autoLabel;
      patch.labelSource = 'auto';
    }
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
        const usedJson = await loadBlockNoteContent(
          editor,
          markdown,
          contentJson,
          contentJsonSource,
        );

        // Expand the __all__ sentinel provenance into per-block entries
        const rawProvenance = data.provenance as BlockProvenanceMap | undefined;
        const blockIds = editor.document.map((b: { id: string }) => b.id);
        const expanded = expandSentinelProvenance(rawProvenance, blockIds);

        if (expanded && expanded !== rawProvenance) {
          provenanceRef.current = expanded;
          setProvenance(expanded);
          // Persist the expanded provenance back
          if (!readOnly && onDataChange) {
            onDataChange({ provenance: expanded });
          }
        } else {
          provenanceRef.current = rawProvenance;
          setProvenance(rawProvenance);
        }

        // Capture initial block IDs for change tracking
        prevBlockIdsRef.current = new Set(blockIds);

        // If markdown was re-parsed (JSON was absent or stale), write back a
        // fresh contentJson so the next open is lossless.
        if (!usedJson && !readOnly) {
          const newJson = JSON.stringify(editor.document);
          writePatch(markdown, newJson, undefined, expanded ?? rawProvenance);
        }
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

    const blockIds = editor.document.map((b: { id: string }) => b.id);
    const expanded = expandSentinelProvenance(current, blockIds);
    if (expanded && expanded !== current) {
      provenanceRef.current = expanded;
      setProvenance(expanded);
      if (!readOnly && onDataChange) {
        onDataChange({ provenance: expanded });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Generate dynamic CSS rules for persistent per-block provenance color bars.
  // BlockNote renders blocks as `.bn-block[data-id="<blockId>"]`.
  const provenanceCss = useMemo(() => {
    if (!provenance) return '';
    const rules: string[] = [];
    for (const [blockId, entry] of Object.entries(provenance)) {
      if (blockId === '__all__') continue;
      // Sanitize block ID for CSS selector (BlockNote IDs are UUIDs)
      const safeId = blockId.replace(/[^a-zA-Z0-9_-]/g, '');
      const status = getBlockAuthorStatus(entry);
      if (status === 'ai') {
        rules.push(
          `.bn-block[data-id="${safeId}"] { border-right: 4px solid var(--color-ai-light); padding-right: 6px; }`,
        );
      } else if (status === 'user-modified') {
        rules.push(
          `.bn-block[data-id="${safeId}"] { border-right: 4px dashed var(--color-ai-light); padding-right: 6px; }`,
        );
      }
    }
    return rules.join('\n');
  }, [provenance]);

  return (
    <div className="custom-scrollbar h-full w-full overflow-auto bg-white px-0 py-3">
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

            const newJson = JSON.stringify(editor.document);
            const md = editor.blocksToMarkdownLossy(editor.document);
            const newMarkdown = md.trim();
            lastAppliedMarkdownRef.current = newMarkdown;

            // Track provenance: detect which blocks changed or are new
            const currentBlockIds = editor.document.map(
              (b: { id: string }) => b.id,
            );
            let updatedProvenance = provenanceRef.current;

            // Record user edits for blocks that are new or had content changes
            for (const blockId of currentBlockIds) {
              if (!prevBlockIdsRef.current.has(blockId)) {
                // New block added by user
                updatedProvenance = recordUserEdit(updatedProvenance, blockId);
              }
            }

            // For existing blocks, we record user edit on the text cursor block
            const cursorBlock = editor.getTextCursorPosition()?.block;
            if (cursorBlock && prevBlockIdsRef.current.has(cursorBlock.id)) {
              updatedProvenance = recordUserEdit(
                updatedProvenance,
                cursorBlock.id,
              );
            }

            // Remove provenance entries for deleted blocks
            if (updatedProvenance) {
              const currentIdSet = new Set(currentBlockIds);
              const cleaned = { ...updatedProvenance };
              let didClean = false;
              for (const key of Object.keys(cleaned)) {
                if (key !== '__all__' && !currentIdSet.has(key)) {
                  delete cleaned[key];
                  didClean = true;
                }
              }
              if (didClean) updatedProvenance = cleaned;
            }

            provenanceRef.current = updatedProvenance;
            setProvenance(updatedProvenance);
            prevBlockIdsRef.current = new Set(currentBlockIds);

            const isLabelUserSet = data.labelSource === 'user';
            const autoLabel = isLabelUserSet
              ? undefined
              : extractLabelFromBlocks(
                  editor.document as Parameters<
                    typeof extractLabelFromBlocks
                  >[0],
                ) || undefined;
            writePatch(newMarkdown, newJson, autoLabel, updatedProvenance);
          }}
        >
          {!readOnly && <SideMenuController sideMenu={NoteEditorSideMenu} />}
        </BlockNoteView>
      </NoteSourceIdProvider>
    </div>
  );
};
