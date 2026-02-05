import { Copy } from 'lucide-react';

import { copyToClipboard } from '../../../../utils/clipboard';
import { GhostButton } from '../../../Common/GhostButton';

interface AIMessageProps {
  content: string;
}

export const AIMessage = ({ content }: AIMessageProps) => {
  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        <div className="text-m text-main rounded-2xl border border-none bg-white px-3 pt-3 pb-1">
          <div className="leading-relaxed whitespace-pre-wrap">{content}</div>
        </div>

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
      </div>
    </div>
  );
};
