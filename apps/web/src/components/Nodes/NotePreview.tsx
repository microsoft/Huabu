import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { useEffect, useRef } from 'react';

import { blockNoteShadcnOverrides } from '@/components/BlockNote/shadcnOverrides';

export interface PreviewComponentProps {
  data: Record<string, unknown>;
  readOnly?: boolean;
  onContentChange?: (newContent: string) => void;
}

export const NotePreview = ({
  data,
  readOnly,
  onContentChange,
}: PreviewComponentProps) => {
  const content = typeof data.content === 'string' ? data.content : '';

  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
    trailingBlock: false,
  });

  const lastAppliedMarkdownRef = useRef<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    const raw = content ?? '';
    if (lastAppliedMarkdownRef.current === raw) return;

    lastAppliedMarkdownRef.current = raw;

    void (async () => {
      const markdown = raw.trim() === '' ? '\n' : raw;
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      editor.replaceBlocks(editor.document, blocks);
    })();
  }, [content, editor]);

  return (
    <div className="custom-scrollbar h-full w-full overflow-auto bg-white p-4">
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        shadCNComponents={blockNoteShadcnOverrides}
        onChange={() => {
          if (readOnly || !onContentChange) return;

          if (debounceRef.current) window.clearTimeout(debounceRef.current);
          debounceRef.current = window.setTimeout(() => {
            const markdown = editor
              .blocksToMarkdownLossy(editor.document)
              .trim();
            lastAppliedMarkdownRef.current = markdown;
            onContentChange(markdown);
          }, 150);
        }}
      />
    </div>
  );
};
