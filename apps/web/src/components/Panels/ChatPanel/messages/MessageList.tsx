import { AIMessage } from './AIMessage';
import { UserMessage } from './UserMessage';

import type { ChatMessage } from './types';
import type { RefObject } from 'react';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  loadingText: string;
  endRef: RefObject<HTMLDivElement>;
}

export const MessageList = ({
  messages,
  isLoading,
  loadingText,
  endRef,
}: MessageListProps) => {
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      {messages.map((msg) => {
        if (msg.role === 'user') {
          return <UserMessage key={msg.id} content={msg.content} />;
        }

        if (msg.role === 'assistant') {
          return <AIMessage key={msg.id} content={msg.content} />;
        }
      })}

      {isLoading && (
        <div className="flex justify-start">
          <div className="animate-pulse rounded-lg bg-gray-100 p-3 text-sm text-gray-500">
            {loadingText}
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
};
