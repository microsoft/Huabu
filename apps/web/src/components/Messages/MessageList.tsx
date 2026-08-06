import { ArrowDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { AIMessage } from './AIMessage';
import { IntentSelectMessage } from './IntentSelectMessage';
import { positionMessageListOnOpen } from './messageListScroll';
import { StatusMessage } from './StatusMessage';
import { UserMessage } from './UserMessage';
import { Button } from '../Common/Button';
import { Loading } from '../Common/Loading';
import { ThinkingIndicator } from '../Common/ThinkingIndicator';

import type { MessageListPreferredPosition } from './messageListScroll';
import type { ChatMessage } from '../../store/chatTypes';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  /**
   * True while the chat history is being hydrated from the server.
   * Rendered as a skeleton placeholder — distinct from `isLoading`
   * (which means the agent is actively producing a response).
   */
  isHistoryLoading?: boolean;
  /** Hide action buttons on AI messages (e.g. in operate mode). */
  hideAIActions?: boolean;
  /** Called when user re-selects an intent from the intent-select message. */
  onIntentReselect?: (messageId: string, intent: string) => void;
  /** Called when the user clicks retry on an interrupted status message. */
  onRetry?: () => void;
  /** Stable identity for the conversation currently rendered by the list. */
  viewKey?: string;
  /** Whether the containing panel is expanded and visible. */
  isActive?: boolean;
  /** Where to position the list when the conversation opens. */
  openPosition?: MessageListPreferredPosition;
}

export const MessageList = ({
  messages,
  isLoading,
  isHistoryLoading,
  hideAIActions,
  onIntentReselect,
  onRetry,
  viewKey,
  isActive = true,
  openPosition = 'bottom',
}: MessageListProps) => {
  const [hasNewMessage, setHasNewMessage] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(messages.length);
  const currentMessageCountRef = useRef(messages.length);
  currentMessageCountRef.current = messages.length;

  // Opening a conversation is a deliberate navigation action. Position the
  // list before paint at the final user message (unread) or end (read / blocked).
  // Direct scrollTop writes keep movement scoped to this panel.
  useLayoutEffect(() => {
    if (!isActive || isHistoryLoading) return;
    const container = containerRef.current;
    if (!container) return;

    const position = positionMessageListOnOpen(container, openPosition);
    isAtBottomRef.current = position !== 'last-user';

    setHasNewMessage(false);
    prevMessageCountRef.current = currentMessageCountRef.current;
  }, [viewKey, isActive, isHistoryLoading, openPosition]);

  // Find the in-flight assistant message for the *current* turn.
  //
  // We walk backwards from the tail and stop at the most recent `user`
  // message — any assistant message that appears before that user turn
  // belongs to a *previous* exchange and must not be tagged as
  // streaming. This matters during the "preparing prompt" phase
  // (external ACP agents): a fresh `user` + `prepared-prompt` pair is
  // already in the list, but the new assistant message isn't inserted
  // until the first content event arrives. Without this guard, naive
  // `findLast(role === 'assistant')` returns the *previous* turn's
  // assistant message and the `ThinkingIndicator` ends up attached to
  // the wrong bubble.
  const streamingAssistantId = (() => {
    if (!isLoading) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === 'user') return undefined;
      if (m.role === 'assistant') return m.id;
    }
    return undefined;
  })();

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

  // Scroll the thread's own container rather than `scrollIntoView` on a
  // sentinel: that walks up every scrollable ancestor, and the app root is
  // `overflow: hidden`, so any bubbling scroll shifts the whole UI with no
  // scrollbar left to undo it.
  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Auto-scroll when at bottom and content changes (including streaming tokens)
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollThreadToBottom('smooth');
    }
  }, [messages, isLoading, scrollThreadToBottom]);

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
    scrollThreadToBottom('smooth');
    setHasNewMessage(false);
  }, [scrollThreadToBottom]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-chat-thread-root
        className="flex-1 space-y-1 overflow-x-visible overflow-y-auto px-3"
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
                  selectedStrokeIds={msg.selectedStrokeIds}
                  invokedSkills={msg.invokedSkills}
                />,
              );
              i++;
              continue;
            }

            if (msg.role === 'assistant') {
              elements.push(
                <AIMessage
                  key={msg.id}
                  messageId={msg.id}
                  segments={msg.segments}
                  isStreaming={msg.id === streamingAssistantId}
                  hideActions={hideAIActions}
                />,
              );
              i++;
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

            i++;
          }
          return elements;
        })()}

        {isLoading && !streamingAssistantId && (
          <div className="flex justify-start">
            <div className="px-3 py-2">
              <ThinkingIndicator />
            </div>
          </div>
        )}

        {isHistoryLoading && messages.length === 0 && (
          <div className="px-3 py-2">
            <Loading variant="skeleton" layout="bare" />
          </div>
        )}
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
