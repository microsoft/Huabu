import { Copy } from 'lucide-react';

import { BlockNoteCard } from './BlockNoteCard';
import { copyToClipboard } from '../../../../utils/clipboard';
import { GhostButton } from '../../../Common/GhostButton';

interface AIMessageProps {
  content: string;
  isStreaming?: boolean;
}

export const AIMessage = ({ content, isStreaming }: AIMessageProps) => {
  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        <div className="text-m text-main ml-1 rounded-2xl border border-none bg-white px-4 pt-2">
          <div className="leading-relaxed">
            <BlockNoteCard content={content} />
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
