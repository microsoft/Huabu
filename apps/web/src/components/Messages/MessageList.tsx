import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AIMessage } from './AIMessage';
import { IntentSelectMessage } from './IntentSelectMessage';
import { PreparedPromptCard } from './PreparedPromptCard';
import { StatusMessage } from './StatusMessage';
import { ToolMessageGroup } from './ToolMessage';
import { UserMessage } from './UserMessage';
import { Button } from '../Common/Button';
import { ThinkingIndicator } from '../Common/ThinkingIndicator';

import type { ToolEntry } from './ToolMessage';
import type { ChatMessage } from './types';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  /** Hide action buttons on AI messages (e.g. in operate mode). */
  hideAIActions?: boolean;
  /** Called when user re-selects an intent from the intent-select message. */
  onIntentReselect?: (messageId: string, intent: string) => void;
  /** Called when the user clicks retry on an interrupted status message. */
  onRetry?: () => void;
}

export const MessageList = ({
  messages,
  isLoading,
  hideAIActions,
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
        {(() => {
          const elements: React.ReactNode[] = [];
          let i = 0;
          while (i < messages.length) {
            const msg = messages[i]!;

            if (msg.role === 'user') {
              elements.push(
                <UserMessage
                  key={msg.id}
                  content={msg.content}
                  attachments={msg.attachments}
                  selectedNodeIds={msg.selectedNodeIds}
                />,
              );
              i++;
              continue;
            }

            if (msg.role === 'assistant') {
              elements.push(
                <AIMessage
                  key={msg.id}
                  content={msg.content}
                  isStreaming={msg.id === streamingAssistantId}
                  resources={msg.resources}
                  hideActions={hideAIActions}
                />,
              );
              i++;
              continue;
            }

            if (msg.role === 'tool') {
              // Group consecutive tool messages of the same tool type
              const toolName = msg.toolResponse.tool;
              const group: ToolEntry[] = [];
              while (i < messages.length) {
                const cur = messages[i];
                if (cur?.role !== 'tool' || cur.toolResponse.tool !== toolName)
                  break;
                group.push({
                  messageId: cur.id,
                  toolResponse: cur.toolResponse,
                  isExecuting: cur.isExecuting,
                });
                i++;
              }
              elements.push(
                <ToolMessageGroup
                  key={group.map((e) => e.messageId).join(',')}
                  entries={group}
                />,
              );
              continue;
            }

            if (msg.role === 'intent-select') {
              elements.push(
                <IntentSelectMessage
                  key={msg.id}
                  candidates={msg.candidates}
                  selectedIntent={msg.selectedIntent}
                  onReselect={(intent) => onIntentReselect?.(msg.id, intent)}
                />,
              );
              i++;
              continue;
            }

            if (msg.role === 'status') {
              elements.push(
                <StatusMessage
                  key={msg.id}
                  status={msg.status}
                  detail={msg.detail}
                  onRetry={onRetry}
                />,
              );
              i++;
              continue;
            }

            if (msg.role === 'prepared-prompt') {
              elements.push(
                <PreparedPromptCard
                  key={msg.id}
                  prompt={msg.prompt}
                  agentAlias={msg.agentAlias}
                  error={msg.error}
                />,
              );
              i++;
              continue;
            }

            i++;
          }
          return elements;
        })()}

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
          variant="outline"
          shape="pill"
          tone="neutral"
          onClick={scrollToBottom}
          className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 shadow-lg"
        >
          New message
          <ArrowDown />
        </Button>
      )}
    </div>
  );
};
