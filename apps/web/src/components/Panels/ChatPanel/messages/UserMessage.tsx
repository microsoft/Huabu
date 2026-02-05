import { Copy } from 'lucide-react';

import { copyToClipboard } from '../../../../utils/clipboard';
import { IconButton } from '../../../Common/IconButton';

interface UserMessageProps {
  content: string;
}

export const UserMessage = ({ content }: UserMessageProps) => {
  return (
    <div className="flex justify-end">
      <div className="flex w-full max-w-[80%] flex-col items-end gap-2">
        <div className="border-border shadow-bottom rounded-2xl border bg-white p-4 text-sm text-gray-900">
          <div className="leading-relaxed whitespace-pre-wrap">{content}</div>
        </div>

        <div className="flex items-center gap-2">
          <IconButton
            aria-label="Copy message"
            title="Copy"
            size="sm"
            variant="outline"
            onClick={() => copyToClipboard(content)}
          >
            <Copy size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
};
