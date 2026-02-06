import { Copy } from 'lucide-react';

import { copyToClipboard } from '../../../../utils/clipboard';
import { GhostButton } from '../../../Common/GhostButton';

interface UserMessageProps {
  content: string;
}

export const UserMessage = ({ content }: UserMessageProps) => {
  return (
    <div className="flex justify-end">
      <div className="flex w-full flex-col items-end gap-1">
        <div className="bg-background text-m text-main rounded-2xl border border-none p-3">
          <div className="leading-relaxed whitespace-pre-wrap">{content}</div>
        </div>

        <div className="flex items-center gap-2">
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
