import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useEffect, useRef } from 'react';

import { blockNoteShadcnOverrides } from '@/components/BlockNote/shadcnOverrides';
import { loadBlockNoteContent } from '@/utils/blockNoteContent';

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

export const NotePreview = ({
  data,
  readOnly,
  onContentChange,
  onDataChange,
}: PreviewComponentProps) => {
  // `content` is the canonical Markdown string.
  // `contentJson` is the auxiliary BlockNote JSON (lossless, editor-internal).
  const markdown = typeof data.content === 'string' ? data.content : '';
  const contentJson =
    typeof data.contentJson === 'string' ? data.contentJson : null;

  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
    trailingBlock: false,
  });

  // Track the last Markdown we applied so we can skip no-op updates.
  const lastAppliedMarkdownRef = useRef<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  /** Write a content patch back to the parent. */
  const writePatch = (newMarkdown: string, newJson: string) => {
    const patch = { content: newMarkdown, contentJson: newJson };
    if (onDataChange) {
      onDataChange(patch);
    } else if (onContentChange) {
      onContentChange(newMarkdown);
    }
  };

  useEffect(() => {
    if (lastAppliedMarkdownRef.current === markdown) return;

    lastAppliedMarkdownRef.current = markdown;

    void (async () => {
      const usedJson = await loadBlockNoteContent(
        editor,
        markdown,
        contentJson,
      );

      // If markdown was re-parsed (JSON was absent or stale), write back a
      // fresh contentJson so the next open is lossless.
      if (!usedJson && !readOnly) {
        const newJson = JSON.stringify(editor.document);
        writePatch(markdown, newJson);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, contentJson, editor]);

  return (
    <div className="custom-scrollbar h-full w-full overflow-auto bg-white p-4">
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        shadCNComponents={blockNoteShadcnOverrides}
        onChange={() => {
          if (readOnly) return;
          if (!onContentChange && !onDataChange) return;

          if (debounceRef.current) window.clearTimeout(debounceRef.current);
          debounceRef.current = window.setTimeout(() => {
            const newJson = JSON.stringify(editor.document);
            const newMarkdown = editor
              .blocksToMarkdownLossy(editor.document)
              .trim();
            lastAppliedMarkdownRef.current = newMarkdown;
            writePatch(newMarkdown, newJson);
          }, 150);
        }}
      />
    </div>
  );
};
