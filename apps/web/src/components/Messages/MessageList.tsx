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

import { isEditableTarget } from '@/hooks/shortcuts/isEditableTarget';

import { AIMessage } from './AIMessage';
import {
  isMessageListNearBottom,
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
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const previousMessagesRef = useRef(messages);
  const lastScrollTopRef = useRef(0);
  const scrollInteractionRef = useRef(0);
  const touchYRef = useRef<number | undefined>(undefined);
  const positionedViewKeyRef = useRef<string | undefined>(undefined);
  const hasPositionedViewRef = useRef(false);
  const handledOpenRequestRef = useRef<number | undefined>(undefined);
  const prependAnchorRef = useRef<{
    messageId: string;
    viewportTop: number;
  } | null>(null);
  const prependObserverRef = useRef<ResizeObserver | null>(null);
  const prependSettleTimerRef = useRef<number | undefined>(undefined);

  const canScroll = useCallback(() => {
    const container = containerRef.current;
    return (
      !!container &&
      isActive &&
      !isHistoryLoading &&
      container.closest('[data-preview-active="false"]') === null
    );
  }, [isActive, isHistoryLoading]);

  const updateBottomAffordance = useCallback(() => {
    const container = containerRef.current;
    if (!container || !canScroll()) return;
    const atBottom = isMessageListNearBottom(container);
    setIsAwayFromBottom(!atBottom);
    if (atBottom) setHasNewMessage(false);
    lastScrollTopRef.current = container.scrollTop;
  }, [canScroll]);

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
    if (!canScroll()) return;
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
    const restoredAtBottom = restored && isMessageListNearBottom(container);
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
    previousMessagesRef.current = messages;
    updateBottomAffordance();
    positionedViewKeyRef.current = viewKey;
    hasPositionedViewRef.current = true;
    if (openPositionRequestNonce !== undefined) {
      handledOpenRequestRef.current = openPositionRequestNonce;
      onOpenPositionHandled?.(openPositionRequestNonce);
    }
    if (!restored) return;
    const interaction = scrollInteractionRef.current;
    const frame = requestAnimationFrame(() => {
      const current = containerRef.current;
      if (
        !current ||
        !canScroll() ||
        interaction !== scrollInteractionRef.current
      ) {
        return;
      }
      restoreMessageListScrollPosition(current, viewKey);
      isAtBottomRef.current = isMessageListNearBottom(current);
      updateBottomAffordance();
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
    canScroll,
    messages,
    updateBottomAffordance,
  ]);

  useLayoutEffect(() => {
    const pending = prependAnchorRef.current;
    const container = containerRef.current;
    const content = contentRef.current;
    if (!pending || !container || !content) return;

    const restoreAnchor = () => {
      if (!canScroll() || prependAnchorRef.current !== pending) return;
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
      updateBottomAffordance();
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
    canScroll,
    updateBottomAffordance,
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
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'user') return undefined;
      if (m.role === 'assistant') return m.id;
    }
    return undefined;
  })();

  // Track whether the user is scrolled near the bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el || !canScroll()) return;
    rememberMessageListScrollAnchor(el, viewKey);
    // Layout growth can emit scroll events without a user leaving the bottom.
    if (el.scrollTop !== lastScrollTopRef.current) {
      scrollInteractionRef.current++;
      isAtBottomRef.current = isMessageListNearBottom(el);
    }
    updateBottomAffordance();
  }, [viewKey, canScroll, updateBottomAffordance]);

  const takeOverScroll = useCallback(() => {
    if (!canScroll()) return;
    scrollInteractionRef.current++;
    isAtBottomRef.current = false;
    finishPrependAnchoring();
  }, [canScroll, finishPrependAnchoring]);

  const loadOlderHistory = useCallback(() => {
    const container = containerRef.current;
    if (!container || !onLoadOlderHistory || isLoadingOlderHistory) return;
    isAtBottomRef.current = false;
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
  const scrollThreadToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el || !canScroll()) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
    updateBottomAffordance();
  }, [canScroll, updateBottomAffordance]);

  useLayoutEffect(() => {
    const previous = previousMessagesRef.current;
    previousMessagesRef.current = messages;
    const tail = messages[messages.length - 1];
    if (
      canScroll() &&
      tail &&
      tail !== previous[previous.length - 1] &&
      !isAtBottomRef.current &&
      !prependAnchorRef.current &&
      !isLoadingOlderHistory
    ) {
      setHasNewMessage(true);
    }
    if (isAtBottomRef.current && !prependAnchorRef.current) {
      scrollThreadToBottom();
    } else {
      updateBottomAffordance();
    }
  }, [
    messages,
    isLoading,
    isLoadingOlderHistory,
    canScroll,
    scrollThreadToBottom,
    updateBottomAffordance,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || !canScroll()) return;
    const resize = () => {
      if (!canScroll() || container.clientHeight === 0) return;
      // A native scroll may precede its scroll event; do not undo that movement.
      if (
        container.scrollTop !== lastScrollTopRef.current &&
        !prependAnchorRef.current
      ) {
        isAtBottomRef.current = isMessageListNearBottom(container);
      }
      if (isAtBottomRef.current && !prependAnchorRef.current) {
        scrollThreadToBottom();
      } else {
        updateBottomAffordance();
      }
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(content);
    observer?.observe(container);
    resize();
    return () => observer?.disconnect();
  }, [viewKey, canScroll, scrollThreadToBottom, updateBottomAffordance]);

  const scrollToBottom = useCallback(() => {
    finishPrependAnchoring();
    scrollInteractionRef.current++;
    isAtBottomRef.current = true;
    scrollThreadToBottom();
  }, [finishPrependAnchoring, scrollThreadToBottom]);

  useEffect(() => finishPrependAnchoring, [finishPrependAnchoring]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheelCapture={(event) => {
          finishPrependAnchoring();
          if (event.deltaY < 0) takeOverScroll();
        }}
        onTouchStartCapture={(event) => {
          touchYRef.current = event.touches[0]?.clientY;
        }}
        onTouchMoveCapture={(event) => {
          const nextY = event.touches[0]?.clientY;
          finishPrependAnchoring();
          if (
            nextY !== undefined &&
            touchYRef.current !== undefined &&
            nextY > touchYRef.current
          ) {
            takeOverScroll();
          }
          touchYRef.current = nextY;
        }}
        onPointerDownCapture={(event) => {
          finishPrependAnchoring();
          if (event.target === event.currentTarget) takeOverScroll();
        }}
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
            const target = event.target;
            if (
              !isEditableTarget(target) &&
              (!(target instanceof HTMLElement) ||
                !target.closest('select, button'))
            ) {
              finishPrependAnchoring();
              if (
                ['ArrowUp', 'Home', 'PageUp'].includes(event.key) ||
                (event.key === ' ' && event.shiftKey)
              ) {
                takeOverScroll();
              }
            }
          }
        }}
        data-chat-thread-root
        tabIndex={-1}
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
                      inputKind={msg.inputKind}
                      inferredIntent={msg.inferredIntent}
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

      {isAwayFromBottom && (
        <Button
          variant="outline"
          shape="pill"
          tone="neutral"
          onClick={(event) => {
            if (document.activeElement === event.currentTarget) {
              containerRef.current?.focus({ preventScroll: true });
            }
            scrollToBottom();
          }}
          className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 shadow-lg"
        >
          {t(hasNewMessage ? 'chat.newMessage' : 'chat.backToBottom')}
          <ArrowDown />
        </Button>
      )}
    </div>
  );
});
