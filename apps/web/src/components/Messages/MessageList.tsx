// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowDown } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { AIMessage } from './AIMessage';
import {
  positionMessageListOnOpen,
  rememberMessageListScrollAnchor,
  rememberMessageListScrollPosition,
  restoreMessageListScrollPosition,
} from './messageListScroll';
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
  /** Called when the user clicks retry on an interrupted status message. */
  onRetry?: () => void;
  /** Whether the server has complete display turns older than this window. */
  hasOlderHistory?: boolean;
  /** Number of turns the next expansion will request. */
  olderTurnBatchSize?: number;
  /** True while an older page is being prepended. */
  isLoadingOlderHistory?: boolean;
  /** A recoverable older-page error; current messages remain visible. */
  olderHistoryError?: string;
  /** Fetch and prepend the next older page. */
  onLoadOlderHistory?: () => void;
  /** Stable identity for the conversation currently rendered by the list. */
  viewKey?: string;
  /** Whether the containing panel is expanded and visible. */
  isActive?: boolean;
  /** Where to position the list when the conversation opens. */
  openPosition?: MessageListPreferredPosition;
  /** Identity of an explicit one-shot positioning request. */
  openPositionRequestNonce?: number;
  onOpenPositionHandled?: (nonce: number) => void;
}

export const MessageList = memo(function MessageList({
  messages,
  isLoading,
  isHistoryLoading,
  hideAIActions,
  onRetry,
  hasOlderHistory,
  olderTurnBatchSize,
  isLoadingOlderHistory,
  olderHistoryError,
  onLoadOlderHistory,
  viewKey,
  isActive = true,
  openPosition = 'bottom',
  openPositionRequestNonce,
  onOpenPositionHandled,
}: MessageListProps) {
  const { t } = useTranslation();
  const [hasNewMessage, setHasNewMessage] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(messages.length);
  const currentMessageCountRef = useRef(messages.length);
  const positionedViewKeyRef = useRef<string | undefined>(undefined);
  const hasPositionedViewRef = useRef(false);
  const handledOpenRequestRef = useRef<number | undefined>(undefined);
  const prependAnchorRef = useRef<{
    messageId: string;
    viewportTop: number;
  } | null>(null);
  const prependObserverRef = useRef<ResizeObserver | null>(null);
  const prependSettleTimerRef = useRef<number | undefined>(undefined);
  currentMessageCountRef.current = messages.length;

  const finishPrependAnchoring = useCallback(() => {
    prependAnchorRef.current = null;
    prependObserverRef.current?.disconnect();
    prependObserverRef.current = null;
    if (prependSettleTimerRef.current !== undefined) {
      window.clearTimeout(prependSettleTimerRef.current);
      prependSettleTimerRef.current = undefined;
    }
  }, []);

  const schedulePrependAnchorSettlement = useCallback(() => {
    if (prependSettleTimerRef.current !== undefined) {
      window.clearTimeout(prependSettleTimerRef.current);
    }
    prependSettleTimerRef.current = window.setTimeout(
      finishPrependAnchoring,
      500,
    );
  }, [finishPrependAnchoring]);

  // Opening a conversation is a deliberate navigation action. Position the
  // list before paint at the final user message (unread) or end (read / blocked).
  // Direct scrollTop writes keep movement scoped to this panel.
  useLayoutEffect(() => {
    if (!isActive || isHistoryLoading) return;
    const container = containerRef.current;
    if (!container) return;
    const viewChanged =
      !hasPositionedViewRef.current || positionedViewKeyRef.current !== viewKey;
    const hasNewRequest =
      openPositionRequestNonce !== undefined &&
      handledOpenRequestRef.current !== openPositionRequestNonce;
    if (!viewChanged && !hasNewRequest) return;
    finishPrependAnchoring();

    const restored = restoreMessageListScrollPosition(container, viewKey);
    const restoredAtBottom =
      restored &&
      container.scrollTop >=
        container.scrollHeight - container.clientHeight - 50;
    const position = restored
      ? restoredAtBottom
        ? 'bottom'
        : 'restored'
      : positionMessageListOnOpen(container, openPosition);
    isAtBottomRef.current = position !== 'last-user' && position !== 'restored';

    setHasNewMessage(
      restored &&
        !restoredAtBottom &&
        hasNewRequest &&
        openPosition === 'last-user',
    );
    prevMessageCountRef.current = currentMessageCountRef.current;
    positionedViewKeyRef.current = viewKey;
    hasPositionedViewRef.current = true;
    if (openPositionRequestNonce !== undefined) {
      handledOpenRequestRef.current = openPositionRequestNonce;
      onOpenPositionHandled?.(openPositionRequestNonce);
    }
    if (!restored) return;
    const frame = requestAnimationFrame(() => {
      const current = containerRef.current;
      if (!current) return;
      restoreMessageListScrollPosition(current, viewKey);
      isAtBottomRef.current =
        current.scrollTop >= current.scrollHeight - current.clientHeight - 50;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    viewKey,
    isActive,
    isHistoryLoading,
    openPosition,
    openPositionRequestNonce,
    onOpenPositionHandled,
    finishPrependAnchoring,
  ]);

  useLayoutEffect(() => {
    const pending = prependAnchorRef.current;
    const container = containerRef.current;
    const content = contentRef.current;
    if (!pending || !container || !content) return;

    const restoreAnchor = () => {
      const anchor = Array.from(
        content.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
      ).find((element) => element.dataset.chatMessageId === pending.messageId);
      if (!anchor) {
        finishPrependAnchoring();
        return;
      }
      const delta = anchor.getBoundingClientRect().top - pending.viewportTop;
      if (delta !== 0) {
        container.scrollTop += delta;
        rememberMessageListScrollPosition(viewKey, container.scrollTop);
      }
      schedulePrependAnchorSettlement();
    };

    restoreAnchor();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(restoreAnchor);
      observer.observe(content);
      prependObserverRef.current?.disconnect();
      prependObserverRef.current = observer;
    }
    const frame = requestAnimationFrame(restoreAnchor);
    return () => cancelAnimationFrame(frame);
  }, [
    messages,
    viewKey,
    finishPrependAnchoring,
    schedulePrependAnchorSettlement,
  ]);

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
    rememberMessageListScrollAnchor(el, viewKey);
    const threshold = 50;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isAtBottomRef.current = atBottom;
    if (atBottom) setHasNewMessage(false);
  }, [viewKey]);

  const loadOlderHistory = useCallback(() => {
    const container = containerRef.current;
    if (!container || !onLoadOlderHistory || isLoadingOlderHistory) return;
    const containerTop = container.getBoundingClientRect().top;
    const anchor = Array.from(
      container.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
    ).find((element) => element.getBoundingClientRect().bottom > containerTop);
    if (anchor?.dataset.chatMessageId) {
      prependAnchorRef.current = {
        messageId: anchor.dataset.chatMessageId,
        viewportTop: anchor.getBoundingClientRect().top,
      };
    }
    onLoadOlderHistory();
  }, [isLoadingOlderHistory, onLoadOlderHistory]);

  useEffect(() => {
    if (!isLoadingOlderHistory && olderHistoryError) {
      finishPrependAnchoring();
    }
  }, [finishPrependAnchoring, isLoadingOlderHistory, olderHistoryError]);

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
    if (isAtBottomRef.current && !prependAnchorRef.current) {
      scrollThreadToBottom('smooth');
    }
  }, [messages, isLoading, scrollThreadToBottom]);

  // Show "new message" indicator when messages are added while scrolled up
  useEffect(() => {
    if (
      messages.length > prevMessageCountRef.current &&
      !isAtBottomRef.current &&
      !prependAnchorRef.current
    ) {
      setHasNewMessage(true);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    finishPrependAnchoring();
    scrollThreadToBottom('smooth');
    setHasNewMessage(false);
  }, [finishPrependAnchoring, scrollThreadToBottom]);

  useEffect(() => finishPrependAnchoring, [finishPrependAnchoring]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheelCapture={finishPrependAnchoring}
        onPointerDownCapture={finishPrependAnchoring}
        onKeyDownCapture={(event) => {
          if (
            [
              'ArrowDown',
              'ArrowUp',
              'End',
              'Home',
              'PageDown',
              'PageUp',
              ' ',
            ].includes(event.key)
          ) {
            finishPrependAnchoring();
          }
        }}
        data-chat-thread-root
        className="flex-1 overflow-x-visible overflow-y-auto px-3"
      >
        <div ref={contentRef} className="space-y-1">
          {hasOlderHistory || olderHistoryError ? (
            <div className="flex flex-col items-center gap-1 py-2">
              <Button
                variant="ghost"
                tone={olderHistoryError ? 'danger' : 'neutral'}
                size="sm"
                onClick={loadOlderHistory}
                disabled={isLoadingOlderHistory}
                aria-busy={isLoadingOlderHistory}
              >
                {isLoadingOlderHistory
                  ? t('chat.loadingEarlierTurns')
                  : t('chat.showEarlierTurns', {
                      count: olderTurnBatchSize ?? 3,
                    })}
              </Button>
              {olderHistoryError ? (
                <span role="alert" className="text-danger text-xs">
                  {olderHistoryError}
                </span>
              ) : null}
            </div>
          ) : null}
          {(() => {
            const elements: React.ReactNode[] = [];
            let i = 0;
            while (i < messages.length) {
              const msg = messages[i]!;

              if (msg.role === 'user') {
                elements.push(
                  <div key={msg.id} data-chat-message-id={msg.id}>
                    <UserMessage
                      content={msg.content}
                      attachments={msg.attachments}
                      selectedNodeIds={msg.selectedNodeIds}
                      selectedStrokeIds={msg.selectedStrokeIds}
                      invokedSkills={msg.invokedSkills}
                    />
                  </div>,
                );
                i++;
                continue;
              }

              if (msg.role === 'assistant') {
                elements.push(
                  <div key={msg.id} data-chat-message-id={msg.id}>
                    <AIMessage
                      messageId={msg.id}
                      segments={msg.segments}
                      isStreaming={msg.id === streamingAssistantId}
                      hideActions={hideAIActions}
                    />
                  </div>,
                );
                i++;
                continue;
              }

              if (msg.role === 'status') {
                elements.push(
                  <div key={msg.id} data-chat-message-id={msg.id}>
                    <StatusMessage
                      status={msg.status}
                      detail={msg.detail}
                      onRetry={onRetry}
                    />
                  </div>,
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
});
