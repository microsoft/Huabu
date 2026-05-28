import { Copy } from 'lucide-react';

import { MilkdownMessageCard } from './Card/MilkdownMessageCard';
import { ThinkingCard } from './ThinkingCard';
import { NODE_ICON } from '../../config/nodeIcons';
import useCanvasStore from '../../store/canvasStore';
import { useChatStore } from '../../store/chatStore';
import {
  assistantMessageText,
  type AssistantSegment,
  type ResourceLabel,
} from '../../store/chatTypes';
import { copyToClipboard } from '../../utils/io/clipboard';
import { Button } from '../Common/Button';

import type { CanvasNodeType } from '@sediment/shared';

interface AIMessageProps {
  segments: AssistantSegment[];
  isStreaming?: boolean;
  resources?: ResourceLabel[];
  hideActions?: boolean;
}

const NoteIcon = NODE_ICON.note;

export const AIMessage = ({
  segments,
  isStreaming,
  resources,
  hideActions,
}: AIMessageProps) => {
  const addNode = useCanvasStore((state) => state.addNode);
  const threadId = useChatStore((s) => s.threadId);

  // Plain-text copy / "add as note" only includes visible text — thinking
  // is internal reasoning and shouldn't bleed into derived artifacts.
  const plainText = assistantMessageText(segments);
  const lastIdx = segments.length - 1;

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        {segments.map((seg, idx) => {
          if (seg.kind === 'thinking') {
            // A thinking segment is "still streaming" only when it's the
            // trailing segment of an in-flight turn — once text starts
            // flowing after it, the thinking phase is done.
            const segStreaming = isStreaming && idx === lastIdx;
            return (
              <ThinkingCard
                key={idx}
                text={seg.text}
                isStreaming={segStreaming}
              />
            );
          }
          return (
            <div
              key={idx}
              className="text-fg-default bg-surface ml-1 rounded-2xl border border-none px-4 text-sm"
            >
              <div className="leading-relaxed">
                <MilkdownMessageCard content={seg.text} threadId={threadId} />
              </div>
            </div>
          );
        })}

        {!isStreaming && !hideActions && (
          <div className="ml-1 flex items-center gap-1 px-3">
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              className="text-fg-subtle"
              aria-label="Add as note"
              title="Add as note"
              onClick={() => {
                addNode({
                  nodeType: 'note',
                  data: {
                    content: plainText,
                    origin: { type: 'user-from-chat', threadId },
                  },
                });
              }}
            >
              <NoteIcon />
            </Button>

            <Button
              variant="ghost"
              iconOnly
              size="sm"
              className="text-fg-subtle"
              aria-label="Copy message"
              title="Copy"
              onClick={() => copyToClipboard(plainText)}
            >
              <Copy />
            </Button>

            {resources && resources.length > 0 && (
              <>
                <span className="bg-edge-default mx-1 h-3 w-px" />
                {resources.map((r, i) => {
                  const Icon =
                    NODE_ICON[r.nodeType as CanvasNodeType] ?? NODE_ICON.note;
                  return (
                    <span
                      key={i}
                      className="bg-bg-default text-fg-subtle inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
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
