import { createId } from '@sediment/shared';
import { Copy } from 'lucide-react';

import { BlockNoteCard } from './BlockNoteCard';
import { NODE_ICON } from '../../config/nodeIcons';
import useCanvasStore from '../../store/canvasStore';
import { copyToClipboard } from '../../utils/io/clipboard';
import { IconButton } from '../Common/IconButton';

interface AIMessageProps {
  content: string;
  isStreaming?: boolean;
}

const NoteIcon = NODE_ICON.note;

export const AIMessage = ({ content, isStreaming }: AIMessageProps) => {
  const addNode = useCanvasStore((state) => state.addNode);

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        <div className="text-main ml-1 rounded-2xl border border-none bg-white px-4 pt-2 text-sm">
          <div className="leading-relaxed">
            <BlockNoteCard content={content} />
          </div>
        </div>

        {!isStreaming && (
          <div className="flex items-center gap-1 px-3">
            <IconButton
              className="text-icon"
              aria-label="Add as note"
              title="Add as note"
              onClick={() => {
                addNode({
                  id: createId('node'),
                  type: 'note',
                  position: { x: 200, y: 200 },
                  data: {
                    content,
                  },
                });
              }}
            >
              <NoteIcon size={16} />
            </IconButton>

            <IconButton
              className="text-icon"
              aria-label="Copy message"
              title="Copy"
              onClick={() => copyToClipboard(content)}
            >
              <Copy size={16} />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
};
