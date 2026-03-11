import { SideMenuController, useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useEffect, useRef, useState } from 'react';

import { loadBlockNoteContent } from '@/components/BlockNote/blockNoteContent';
import {
  NoteEditorSideMenu,
  NoteSourceIdProvider,
} from '@/components/BlockNote/NoteEditorSideMenu';
import { blockNoteShadcnOverrides } from '@/components/BlockNote/shadcnOverrides';

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

  /** Write a content patch back to the parent. */
  const writePatch = (
    newMarkdown: string,
    newJson: string,
    autoLabel?: string,
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

        // If markdown was re-parsed (JSON was absent or stale), write back a
        // fresh contentJson so the next open is lossless.
        if (!usedJson && !readOnly) {
          const newJson = JSON.stringify(editor.document);
          writePatch(markdown, newJson);
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, contentJson, editor]);

  return (
    <div className="custom-scrollbar h-full w-full overflow-auto bg-white px-0 py-3">
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
            const isLabelUserSet = data.labelSource === 'user';
            const autoLabel = isLabelUserSet
              ? undefined
              : extractLabelFromBlocks(
                  editor.document as Parameters<
                    typeof extractLabelFromBlocks
                  >[0],
                ) || undefined;
            writePatch(newMarkdown, newJson, autoLabel);
          }}
        >
          {!readOnly && <SideMenuController sideMenu={NoteEditorSideMenu} />}
        </BlockNoteView>
      </NoteSourceIdProvider>
    </div>
  );
};
