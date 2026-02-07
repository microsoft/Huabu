import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import { type Node, type NodeProps } from '@xyflow/react';
import { StickyNote, Copy, Check, Fullscreen } from 'lucide-react';
import { useEffect, useState } from 'react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';
import useStore from '../../store/canvasStore.ts';
import { copyToClipboard } from '../../utils/clipboard.ts';

type NoteNodeData = NodeDataProps & {
  content?: string;
};
export type NoteNodeType = Node<NoteNodeData, 'note'>;

export const NoteNode = ({ id, data, selected }: NodeProps<NoteNodeType>) => {
  const [copied, setCopied] = useState(false);
  const openExpanded = useStore((s) => s.openExpanded);
  const editor = useCreateBlockNote({
    initialContent: [{ type: 'paragraph', content: '' }],
    trailingBlock: false,
  });

  const handleCopy = () => {
    if (data.content) {
      copyToClipboard(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const NoteToolbar = (
    <div className="flex w-full items-center justify-between gap-4">
      {/* Label */}
      <div className="text-muted-foreground flex flex-1 items-center gap-1 text-xs font-medium">
        <StickyNote size={12} />
        <span>Note</span>
      </div>

      {/* Tools */}
      <div className="text-muted-foreground flex items-center gap-2">
        <div className="bg-border h-3 w-px" />

        <button
          className="hover:text-main"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
          }}
          title="Open Large View"
        >
          <Fullscreen size={12} />
        </button>

        <button
          className="hover:text-main"
          onClick={handleCopy}
          title="Copy Content"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );

  useEffect(() => {
    void (async () => {
      const raw = data.content ?? '';
      const markdown = raw.trim() === '' ? '\n' : raw;
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      editor.replaceBlocks(editor.document, blocks);
    })();
  }, [data.content, editor]);

  return (
    <NodeWrapper
      id={id}
      data={data}
      selected={selected}
      toolbar={NoteToolbar}
      keepAspectRatio={false}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openExpanded(id);
      }}
    >
      <div className="flex h-full flex-col bg-white p-2">
        <BlockNoteView
          className="noteview-readonly pointer-events-none select-none"
          editor={editor}
          editable={false}
        />
      </div>
    </NodeWrapper>
  );
};
