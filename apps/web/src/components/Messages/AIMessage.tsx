import { Copy } from 'lucide-react';

import { BlockNoteCard } from './BlockNoteCard';
import { NODE_ICON } from '../../config/nodeIcons';
import useCanvasStore from '../../store/canvasStore';
import { copyToClipboard } from '../../utils/io/clipboard';
import { IconButton } from '../Common/IconButton';

import type { ResourceLabel } from './types';
import type { CanvasNodeType } from '@sediment/shared';

interface AIMessageProps {
  content: string;
  isStreaming?: boolean;
  resources?: ResourceLabel[];
  hideActions?: boolean;
}

const NoteIcon = NODE_ICON.note;

export const AIMessage = ({
  content,
  isStreaming,
  resources,
  hideActions,
}: AIMessageProps) => {
  const addNode = useCanvasStore((state) => state.addNode);

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        <div className="text-main ml-1 rounded-2xl border border-none bg-white px-4 text-sm">
          <div className="leading-relaxed">
            <BlockNoteCard content={content} />
          </div>
        </div>

        {!isStreaming && !hideActions && (
          <div className="ml-1 flex items-center gap-1 px-3">
            <IconButton
              className="text-icon"
              aria-label="Add as note"
              title="Add as note"
              onClick={() => {
                addNode({
                  nodeType: 'note',
                  data: {
                    content,
                    // TODO: update origin
                    origin: { type: 'user-drag-chat' },
                  },
                });
              }}
            >
              <NoteIcon size={12} />
            </IconButton>

            <IconButton
              className="text-icon"
              aria-label="Copy message"
              title="Copy"
              onClick={() => copyToClipboard(content)}
            >
              <Copy size={12} />
            </IconButton>

            {resources && resources.length > 0 && (
              <>
                <span className="bg-border mx-1 h-3 w-px" />
                {resources.map((r, i) => {
                  const Icon =
                    NODE_ICON[r.nodeType as CanvasNodeType] ?? NODE_ICON.note;
                  return (
                    <span
                      key={i}
                      className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                      title={r.label}
                    >
                      <Icon size={10} />
                      <span className="max-w-20 truncate">{r.label}</span>
                    </span>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
