import { type Node, type NodeProps } from '@xyflow/react';
import { StickyNote, Copy, Check } from 'lucide-react';
import { useState } from 'react';

import { NodeWrapper, type NodeDataProps } from './NodeWrapper.tsx';

type NoteNodeData = NodeDataProps & {
  content?: string;
};
export type NoteNodeType = Node<NoteNodeData, 'note'>;

export const NoteNode = ({ id, data, selected }: NodeProps<NoteNodeType>) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (data.content) {
      navigator.clipboard.writeText(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const NoteToolbar = (
    <div className="flex w-full items-center justify-between gap-4">
      {/* Label */}
      <div className="text-secondary flex flex-1 items-center gap-2 text-xs font-medium">
        <StickyNote size={12} />
        <span>Note</span>
      </div>

      {/* Tools */}
      <div className="text-secondary flex items-center gap-2">
        <div className="bg-border h-3 w-px" />

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

  return (
    <NodeWrapper
      id={id}
      data={data}
      selected={selected}
      toolbar={NoteToolbar}
      keepAspectRatio={false}
    >
      <div className="flex h-full flex-col p-1">{data.content}</div>
    </NodeWrapper>
  );
};
