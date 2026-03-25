import { NodeRef } from './NodeRef';

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
  const hasRefs =
    (attachments && attachments.length > 0) ||
    (selectedNodeIds && selectedNodeIds.length > 0);

  return (
    <div className="my-3 flex flex-col items-end">
      <div className="mt-2 flex max-w-[80%] flex-col items-end gap-1">
        <div className="bg-background text-main overflow-hidden rounded-md border border-none px-4 py-2 text-sm">
          <div className="leading-relaxed break-all whitespace-pre-wrap">
            {content}
          </div>
        </div>
      </div>

      {hasRefs && (
        <div className="mt-1 flex w-full items-stretch justify-end gap-2">
          {/* Left: node refs */}
          <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
            {attachments?.map((att, i) => (
              <NodeRef key={att.url ?? `att-${i}`} attachment={att} />
            ))}
            {selectedNodeIds?.map((id) => (
              <NodeRef key={id} nodeId={id} />
            ))}
          </div>

          {/* Middle: vertical separator that stretches to match refs height */}
          {/* <span className="bg-border w-px shrink-0 self-stretch" /> */}

          {/* Right: copy button, top-aligned */}
          {/* <IconButton
            className="text-icon mt-px shrink-0 self-start"
            aria-label="Copy message"
            title="Copy"
            onClick={() => copyToClipboard(content)}
          >
            <Copy size={12} />
          </IconButton> */}
        </div>
      )}
    </div>
  );
};
