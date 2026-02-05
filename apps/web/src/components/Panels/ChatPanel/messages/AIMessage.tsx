import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { Copy } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { copyToClipboard } from '../../../../utils/clipboard';
import { GhostButton } from '../../../Common/GhostButton';

interface AIMessageProps {
  content: string;
  isStreaming?: boolean;
}

export const AIMessage = ({ content, isStreaming }: AIMessageProps) => {
  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
  });

  const parseSeqRef = useRef(0);

  useEffect(() => {
    const mySeq = ++parseSeqRef.current;
    const handle = setTimeout(() => {
      void (async () => {
        const markdown = content.trim() === '' ? '\n' : content;
        const blocks = await editor.tryParseMarkdownToBlocks(markdown);

        if (parseSeqRef.current !== mySeq) return;

        editor.replaceBlocks(editor.document, blocks);
      })();
    }, 150);

    return () => {
      clearTimeout(handle);
    };
  }, [content, editor]);

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        <div className="text-m text-main rounded-2xl border border-none bg-white px-3 pt-3 pb-1">
          <div className="leading-relaxed">
            <BlockNoteView editor={editor} editable={true} />
          </div>
        </div>

        {!isStreaming && (
          <div className="flex items-center gap-2 px-3">
            <GhostButton
              className="text-icon"
              aria-label="Copy message"
              title="Copy"
              onClick={() => copyToClipboard(content)}
            >
              <Copy size={16} />
            </GhostButton>
          </div>
        )}
      </div>
    </div>
  );
};
