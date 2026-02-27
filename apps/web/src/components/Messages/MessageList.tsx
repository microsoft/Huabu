import { Ellipsis } from 'lucide-react';

import { AIMessage } from './AIMessage';
import { ToolMessage } from './ToolMessage';
import { UserMessage } from './UserMessage';

import type { ChatMessage } from './types';
import type { RefObject } from 'react';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  endRef: RefObject<HTMLDivElement>;
}

export const MessageList = ({
  messages,
  isLoading,
  endRef,
}: MessageListProps) => {
  const streamingAssistantId = isLoading
    ? [...messages].reverse().find((m) => m.role === 'assistant')?.id
    : undefined;

  return (
    <div className="flex-1 space-y-1 overflow-x-visible overflow-y-auto">
      {messages.map((msg) => {
        if (msg.role === 'user') {
          return <UserMessage key={msg.id} content={msg.content} />;
        }

        if (msg.role === 'assistant') {
          return (
            <AIMessage
              key={msg.id}
              content={msg.content}
              isStreaming={msg.id === streamingAssistantId}
            />
          );
        }

        if (msg.role === 'tool') {
          return <ToolMessage key={msg.id} toolResponse={msg.toolResponse} />;
        }

        return null;
      })}

      {isLoading && (
        <div className="flex justify-start">
          <div
            className="rounded-2xl border-none px-3 py-2"
            aria-label={'thinking'}
          >
            <Ellipsis className="text-icon animate-pulse" />
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
};
