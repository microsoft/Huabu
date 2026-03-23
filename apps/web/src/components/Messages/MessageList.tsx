import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AIMessage } from './AIMessage';
import { IntentSelectMessage } from './IntentSelectMessage';
import { StatusMessage } from './StatusMessage';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolMessage } from './ToolMessage';
import { UserMessage } from './UserMessage';
import { Button } from '../Common/Button';

import type { ChatMessage } from './types';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  /** Called when user re-selects an intent from the intent-select message. */
  onIntentReselect?: (messageId: string, intent: string) => void;
  /** Called when the user clicks retry on an interrupted status message. */
  onRetry?: () => void;
}

export const MessageList = ({
  messages,
  isLoading,
  onIntentReselect,
  onRetry,
}: MessageListProps) => {
  const [hasNewMessage, setHasNewMessage] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(messages.length);

  const streamingAssistantId = isLoading
    ? [...messages].reverse().find((m) => m.role === 'assistant')?.id
    : undefined;

  // Track whether the user is scrolled near the bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 50;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isAtBottomRef.current = atBottom;
    if (atBottom) setHasNewMessage(false);
  }, []);

  // Auto-scroll when at bottom and content changes (including streaming tokens)
  useEffect(() => {
    if (isAtBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  // Show "new message" indicator when messages are added while scrolled up
  useEffect(() => {
    if (
      messages.length > prevMessageCountRef.current &&
      !isAtBottomRef.current
    ) {
      setHasNewMessage(true);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
    setHasNewMessage(false);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 space-y-1 overflow-x-visible overflow-y-auto"
      >
        {messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <UserMessage
                key={msg.id}
                content={msg.content}
                attachments={msg.attachments}
                selectedNodeIds={msg.selectedNodeIds}
              />
            );
          }

          if (msg.role === 'assistant') {
            return (
              <AIMessage
                key={msg.id}
                content={msg.content}
                isStreaming={msg.id === streamingAssistantId}
                resources={msg.resources}
              />
            );
          }

          if (msg.role === 'tool') {
            return (
              <ToolMessage
                key={msg.id}
                toolResponse={msg.toolResponse}
                isExecuting={msg.isExecuting}
              />
            );
          }

          if (msg.role === 'intent-select') {
            return (
              <IntentSelectMessage
                key={msg.id}
                candidates={msg.candidates}
                selectedIntent={msg.selectedIntent}
                onReselect={(intent) => onIntentReselect?.(msg.id, intent)}
              />
            );
          }

          if (msg.role === 'status') {
            return (
              <StatusMessage
                key={msg.id}
                status={msg.status}
                detail={msg.detail}
                onRetry={onRetry}
              />
            );
          }

          return null;
        })}

        {isLoading && (
          <div className="flex justify-start">
            <div className="px-3 py-2">
              <ThinkingIndicator />
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {hasNewMessage && (
        <Button
          variant="pill"
          onClick={scrollToBottom}
          className="border-border bg-background text-muted-foreground hover:text-foreground absolute bottom-2 left-1/2 z-10 -translate-x-1/2 gap-1.5 shadow-lg"
        >
          New message
          <ArrowDown size={14} />
        </Button>
      )}
    </div>
  );
};
