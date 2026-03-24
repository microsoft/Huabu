import { Copy } from 'lucide-react';

import { NodeRef } from './NodeRef';
import { copyToClipboard } from '../../utils/io/clipboard';
import { IconButton } from '../Common/IconButton';

import type { ChatAttachment } from '@sediment/shared';

interface UserMessageProps {
  content: string;
  attachments?: ChatAttachment[];
  selectedNodeIds?: string[];
}

export const UserMessage = ({
  content,
  attachments,
  selectedNodeIds,
}: UserMessageProps) => {
  return (
    <div className="flex flex-col items-end">
      <div className="mt-2 flex max-w-[80%] flex-col items-end gap-1">
        <div className="bg-background text-main overflow-hidden rounded-md border border-none px-4 py-2 text-sm">
          <div className="leading-relaxed break-all whitespace-pre-wrap">
            {content}
          </div>
        </div>
      </div>

      <div className="mt-1 flex w-full min-w-0 items-center justify-end gap-2">
        {attachments && attachments.length > 0 && (
          <>
            <div className="flex min-w-0 shrink gap-1 overflow-x-auto">
              {attachments.map((att) => (
                <NodeRef key={att.url} attachment={att} />
              ))}
            </div>
            <span className="bg-border mx-0.5 h-3 w-px shrink-0" />
          </>
        )}

        {selectedNodeIds && selectedNodeIds.length > 0 && (
          <>
            <div className="flex min-w-0 shrink gap-1 overflow-x-auto">
              {selectedNodeIds.map((id) => (
                <NodeRef key={id} nodeId={id} />
              ))}
            </div>
            <span className="bg-border mx-0.5 h-3 w-px shrink-0" />
          </>
        )}

        <IconButton
          className="text-icon"
          aria-label="Copy message"
          title="Copy"
          onClick={() => copyToClipboard(content)}
        >
          <Copy size={12} />
        </IconButton>
      </div>
    </div>
  );
};
