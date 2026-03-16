import { Copy } from 'lucide-react';

import { copyToClipboard } from '../../utils/io/clipboard';
import { GhostButton } from '../Common/GhostButton';

import type { ChatAttachment } from '@sediment/shared';

interface UserMessageProps {
  content: string;
  attachments?: ChatAttachment[];
}

export const UserMessage = ({ content, attachments }: UserMessageProps) => {
  return (
    <div className="flex justify-end">
      <div className="flex w-full flex-col items-end gap-1">
        <div className="bg-background text-main rounded-2xl border border-none p-3 text-sm">
          {/* Attachment thumbnails */}
          {attachments && attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((att) => (
                <div
                  key={att.url}
                  className="border-border relative overflow-hidden rounded border"
                >
                  <img
                    src={att.url}
                    alt={att.label ?? 'Attached image'}
                    className="h-16 w-24 object-cover"
                  />
                </div>
              ))}
            </div>
          )}
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
