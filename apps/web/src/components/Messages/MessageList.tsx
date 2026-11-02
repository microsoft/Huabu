// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ArrowDown } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';

import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { ThinkingIndicator } from '@/components/Common/ThinkingIndicator';
import { hashSearchSource } from '@/hooks/useSearchSource';
import { historyMessageIds } from '@/store/chatHistoryCache';
import {
  captureMessageListScrollAnchor,
  readMessageListScrollBookmark,
  rememberMessageListScrollAnchor,
} from '@/store/previewWorkspace/scrollMemory';

import { AIMessage } from './AIMessage';
import { StatusMessage } from './StatusMessage';
import { UserMessage } from './UserMessage';

import '@/components/Common/scrollbar.css';

import type { MessageListPreferredPosition } from './messageListScroll';
import type { ChatHistoryPage } from '@/store/chatHistoryCache';
import type { ChatMessage } from '@/store/chatTypes';
import type { CanvasSearchSource } from '@huabu/shared';
import type {
  ListRange,
  ScrollSeekPlaceholderProps,
  VirtuosoHandle,
} from 'react-virtuoso';

interface MessageListProps {
  onLatestVisibleChange?: (visible: boolean) => void;
  messages: ChatMessage[];
  activationId?: number;
  threadId?: string;
  isLoading: boolean;
  isHistoryLoading?: boolean;
  isHistoryReady?: boolean;
  hideAIActions?: boolean;
  onRetry?: () => void;
  hasOlderHistory?: boolean;
  isLoadingOlderHistory?: boolean;
  olderHistoryError?: string;
  onLoadOlderHistory?: () => void;
  historyPages?: ChatHistoryPage[];
  onLoadHistoryPage?: (page: ChatHistoryPage) => void;
  onVisibleMessagesChange?: (ids: string[]) => void;
  historyPageError?: string;
  onRetryHistoryPage?: () => void;
  viewKey?: string;
  isActive?: boolean;
  openPosition?: MessageListPreferredPosition;
  openPositionRequestNonce?: number;
  onOpenPositionHandled?: (nonce: number) => void;
}

const EMPTY_PAGES: ChatHistoryPage[] = [];
const FIRST_INDEX = 1_000_000;

function StaticPlaceholder() {
  return (
    <Loading
      variant="skeleton"
      layout="bare"
      className="w-full [&_.skeleton-line]:animate-none!"
    />
  );
}

function ScrollPlaceholder({
  height,
  index,
  context,
}: ScrollSeekPlaceholderProps & {
  context?: { ids: string[]; first: number };
}) {
  return (
    <div
      data-chat-seek-placeholder
      data-chat-message-id={context?.ids[index - context.first]}
      data-chat-row-loading
      className="flex items-center overflow-hidden px-3"
      style={{ height }}
      aria-hidden="true"
    >
      <StaticPlaceholder />
    </div>
  );
}

const VIRTUAL_COMPONENTS = { ScrollSeekPlaceholder: ScrollPlaceholder };

export const MessageList = memo(function MessageList(props: MessageListProps) {
  // A different thread must never inherit another thread's virtual measurements.
  return (
    <VirtualMessageList key={props.viewKey ?? props.threadId} {...props} />
  );
});

function VirtualMessageList({
  onLatestVisibleChange,
  messages,
  activationId,
  threadId,
  isLoading,
  isHistoryLoading,
  isHistoryReady = true,
  hideAIActions,
  onRetry,
  hasOlderHistory,
  isLoadingOlderHistory,
  olderHistoryError,
  onLoadOlderHistory,
  historyPages = EMPTY_PAGES,
  onLoadHistoryPage,
  onVisibleMessagesChange,
  historyPageError,
  onRetryHistoryPage,
  viewKey,
  isActive = true,
  openPosition = 'bottom',
  openPositionRequestNonce,
  onOpenPositionHandled,
}: MessageListProps) {
  const { t } = useTranslation();
  const list = useRef<VirtuosoHandle>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [listHeight, setListHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const fillingLatest = useRef(false);
  const byId = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const currentMessages = useRef(byId);
  currentMessages.current = byId;
  const [indexState, setIndexState] = useState(() => ({
    ids: historyMessageIds(historyPages, messages),
    pages: historyPages,
    loadedIds: messages.map((message) => message.id),
    first: FIRST_INDEX,
  }));
  let { ids, first } = indexState;
  if (
    indexState.pages !== historyPages ||
    indexState.loadedIds.length !== messages.length ||
    messages.some(
      (message, index) => message.id !== indexState.loadedIds[index],
    )
  ) {
    ids = historyMessageIds(historyPages, messages);
    const previousFirst = indexState.ids[0];
    const prepended = previousFirst ? ids.indexOf(previousFirst) : -1;
    const removed = ids[0] ? indexState.ids.indexOf(ids[0]) : -1;
    first += prepended >= 0 ? -prepended : Math.max(0, removed);
    setIndexState({
      ids,
      first,
      pages: historyPages,
      loadedIds: messages.map((message) => message.id),
    });
  }
  const [away, setAway] = useState(false);
  const updateAway = useCallback(() => {
    if (!scroller) return;
    const gap =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setAway((wasAway) => gap > (wasAway ? 50 : 160));
  }, [scroller]);
  const [hasNew, setHasNew] = useState(false);
  const [range, setRange] = useState<ListRange>();
  const [search, setSearch] = useState<{
    source?: CanvasSearchSource;
    target?: string;
  }>();
  const [localFind, setLocalFind] = useState(false);
  const materializeSearch =
    localFind || (search !== undefined && !search.source);
  const [searchError, setSearchError] = useState(false);
  const scanned = useRef(new Set<string>());
  const heights = useRef(new Map<string, number>());
  const viewportSize = useRef<string | undefined>(undefined);
  const anchor = useRef(readMessageListScrollBookmark(viewKey));
  const ready = useRef(false);
  const positioning = useRef(false);
  const active = useRef(isActive);
  active.current = isActive;
  const pendingFrame = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const bottomRequest = useRef(false);
  const following = useRef(false);
  const atBottom = useRef(true);
  const latestUser = (() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role === 'user') return messages[index];
    }
    return undefined;
  })();
  const previousUserId = useRef(latestUser?.id);
  const historyWasReady = useRef(isHistoryReady && !isHistoryLoading);
  const placementRequest = useRef(false);
  const targetIndex = useRef(0);
  const allowHistoryLoad = useRef(false);
  const seeking = useRef(false);
  const lastScrollTop = useRef(0);
  const scrollbarDragging = useRef(false);
  const anchorCorrectionUntil = useRef(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekLoading, setSeekLoading] = useState(false);
  const [seekPending, setSeekPending] = useState(false);
  const [visibleMissing, setVisibleMissing] = useState(false);
  const touchY = useRef<number | undefined>(undefined);
  const positionDeadline = useRef(0);
  const handledRequest = useRef<number | undefined>(undefined);
  const previousTail = useRef(messages.at(-1));
  const reportLatestVisible = useCallback(() => {
    const tailId = ids.at(-1);
    const tailRendered =
      !tailId ||
      Array.from(
        scroller?.querySelectorAll<HTMLElement>('[data-chat-message-id]') ?? [],
      ).some(
        (row) =>
          row.dataset.chatMessageId === tailId &&
          !row.hasAttribute('data-chat-row-loading'),
      );
    onLatestVisibleChange?.(
      !!scroller &&
        scroller.clientHeight > 0 &&
        isActive &&
        isHistoryReady &&
        !isHistoryLoading &&
        (ready.current || !ids.length) &&
        !positioning.current &&
        !seeking.current &&
        tailRendered &&
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
          50,
    );
  }, [
    scroller,
    ids,
    isActive,
    isHistoryReady,
    isHistoryLoading,
    onLatestVisibleChange,
  ]);
  useEffect(() => {
    reportLatestVisible();
    return () => onLatestVisibleChange?.(false);
  }, [reportLatestVisible, messages, isSeeking]);
  useLayoutEffect(() => {
    if (anchor.current && !ids.includes(anchor.current.messageId)) {
      const reconciled = readMessageListScrollBookmark(viewKey);
      if (reconciled && ids.includes(reconciled.messageId))
        anchor.current = reconciled;
    }
  }, [ids, viewKey]);

  const saveAnchor = useCallback(() => {
    if (
      !scroller ||
      !ready.current ||
      !active.current ||
      positioning.current ||
      !scroller.clientHeight
    )
      return;
    const next = captureMessageListScrollAnchor(scroller);
    if (!next) return;
    anchor.current = next;
    rememberMessageListScrollAnchor(scroller, viewKey);
  }, [scroller, viewKey]);

  const correctAnchor = useCallback(() => {
    if (
      !scroller ||
      !active.current ||
      !scroller.clientHeight ||
      seeking.current ||
      scrollbarDragging.current
    )
      return;
    if (bottomRequest.current || following.current) {
      anchorCorrectionUntil.current = performance.now() + 200;
      scroller.scrollTop = scroller.scrollHeight;
      atBottom.current = true;
      return;
    }
    if (!anchor.current) return;
    const saved = anchor.current;
    const row = Array.from(
      scroller.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
    ).find((element) => element.dataset.chatMessageId === saved.messageId);
    if (row) {
      if (
        placementRequest.current &&
        !currentMessages.current.has(saved.messageId)
      )
        return;
      if (
        placementRequest.current &&
        row.getBoundingClientRect().height <= -saved.offsetTop
      )
        return;
      const delta =
        row.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        saved.offsetTop;
      if (Math.abs(delta) > 0.5) {
        anchorCorrectionUntil.current = performance.now() + 200;
        scroller.scrollTop += delta;
      }
    } else if (placementRequest.current) {
      list.current?.scrollToIndex({
        index: targetIndex.current,
        align: 'start',
      });
    }
  }, [scroller]);

  const settlePosition = useCallback(() => {
    cancelAnimationFrame(pendingFrame.current);
    clearTimeout(settleTimer.current);
    pendingFrame.current = requestAnimationFrame(() => {
      correctAnchor();
      const finish = () => {
        correctAnchor();
        if (
          placementRequest.current &&
          anchor.current &&
          !currentMessages.current.has(anchor.current.messageId)
        )
          return;
        bottomRequest.current = false;
        placementRequest.current = false;
        positioning.current = false;
        ready.current = true;
        if (scroller)
          atBottom.current =
            scroller.scrollHeight -
              scroller.scrollTop -
              scroller.clientHeight <=
            50;
        saveAnchor();
        reportLatestVisible();
        setLayoutVersion((version) => version + 1);
      };
      if (placementRequest.current) {
        // Let the requested tail finish its initial Markdown measurement, not
        // subsequent streaming. User input cancels this bounded placement.
        settleTimer.current = setTimeout(
          finish,
          Math.max(
            0,
            Math.min(100, positionDeadline.current - performance.now()),
          ),
        );
      } else {
        pendingFrame.current = requestAnimationFrame(finish);
      }
    });
  }, [correctAnchor, saveAnchor, scroller, reportLatestVisible]);

  const takeControl = useCallback(() => {
    fillingLatest.current = false;
    following.current = false;
    lastScrollTop.current = scroller?.scrollTop ?? 0;
    anchorCorrectionUntil.current = 0;
    allowHistoryLoad.current = true;
    bottomRequest.current = false;
    placementRequest.current = false;
    positioning.current = false;
    cancelAnimationFrame(pendingFrame.current);
    clearTimeout(settleTimer.current);
    ready.current = true;
    saveAnchor();
  }, [saveAnchor, scroller]);

  useEffect(() => {
    const release = () => {
      if (!scrollbarDragging.current) return;
      scrollbarDragging.current = false;
      saveAnchor();
      setLayoutVersion((version) => version + 1);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      scrollbarDragging.current = false;
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, [saveAnchor]);

  const scrollSeekConfiguration = useMemo(
    () => ({
      enter: (velocity: number) => {
        if (
          !allowHistoryLoad.current ||
          placementRequest.current ||
          positioning.current ||
          performance.now() < anchorCorrectionUntil.current ||
          Math.abs(velocity) < 800
        )
          return false;
        takeControl();
        seeking.current = true;
        setIsSeeking(true);
        setSeekPending(true);
        return true;
      },
      exit: (velocity: number) => {
        if (Math.abs(velocity) > 80) return false;
        saveAnchor();
        seeking.current = false;
        setIsSeeking(false);
        return true;
      },
    }),
    [saveAnchor, takeControl],
  );

  const jump = useCallback(
    (id?: string, offset = 0) => {
      const index = id ? ids.indexOf(id) : ids.length - 1;
      if (index < 0) return;
      if (id) following.current = false;
      positioning.current = true;
      placementRequest.current = true;
      allowHistoryLoad.current = !!id;
      targetIndex.current = index;
      bottomRequest.current = !id;
      positionDeadline.current = performance.now() + 500;
      anchor.current = id ? { messageId: id, offsetTop: offset } : undefined;
      list.current?.scrollToIndex({
        index,
        align: id ? 'start' : 'end',
        offset: 0,
        behavior: 'auto',
      });
      setHasNew(false);
      settlePosition();
    },
    [ids, settlePosition],
  );

  useLayoutEffect(() => {
    const newUser = latestUser?.id !== previousUserId.current;
    previousUserId.current = latestUser?.id;
    const wasReady = historyWasReady.current;
    historyWasReady.current = isHistoryReady && !isHistoryLoading;
    if (
      !isActive ||
      !wasReady ||
      !isHistoryReady ||
      isHistoryLoading ||
      search ||
      localFind
    )
      return;
    if (
      newUser &&
      latestUser &&
      (!latestUser.historyTurnId || latestUser.historyTurnActive) &&
      atBottom.current
    )
      following.current = true;
    if (following.current) jump();
  }, [
    messages,
    latestUser,
    isActive,
    isHistoryReady,
    isHistoryLoading,
    search,
    localFind,
    jump,
  ]);

  const hasMessages = ids.length > 0;
  useLayoutEffect(() => {
    if (!fillingLatest.current || isLoadingOlderHistory) return;
    fillingLatest.current = false;
    if (isActive && !olderHistoryError && !allowHistoryLoad.current) jump();
  }, [isLoadingOlderHistory, isActive, olderHistoryError, jump]);

  // Activity detaches layout effects. Save the anchor before hidden dimensions
  // can overwrite it, then restore by message identity rather than pixel totals.
  useLayoutEffect(() => {
    if (
      !scroller ||
      !isActive ||
      isHistoryLoading ||
      !isHistoryReady ||
      !ids.length
    )
      return;
    const explicit =
      openPositionRequestNonce !== undefined &&
      handledRequest.current !== openPositionRequestNonce;
    const saved = anchor.current;
    if (explicit) {
      handledRequest.current = openPositionRequestNonce;
      jump(
        openPosition === 'last-user'
          ? [...messages].reverse().find((m) => m.role === 'user')?.id
          : undefined,
      );
      onOpenPositionHandled?.(openPositionRequestNonce);
    } else if (!ready.current) {
      if (saved && !ids.includes(saved.messageId)) {
        setSearchError(true);
        jump();
      } else {
        jump(saved?.messageId, saved?.offsetTop);
      }
    }
    return () => {
      following.current = false;
      saveAnchor();
      if (anchor.current) onVisibleMessagesChange?.([anchor.current.messageId]);
      seeking.current = false;
      setIsSeeking(false);
      setSeekLoading(false);
      setSeekPending(false);
      ready.current = false;
    };
    // Data growth is not an activation and must never issue another jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scroller,
    isActive,
    activationId,
    isHistoryLoading,
    isHistoryReady,
    hasMessages,
    openPositionRequestNonce,
    materializeSearch,
  ]);

  useEffect(
    () => () => {
      cancelAnimationFrame(pendingFrame.current);
      clearTimeout(settleTimer.current);
    },
    [],
  );

  const updateVisibleLoading = useCallback(() => {
    if (!scroller || !active.current) return;
    const top = scroller.getBoundingClientRect().top + scroller.clientTop;
    const bottom = top + scroller.clientHeight;
    setVisibleMissing(
      [
        ...scroller.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
      ].some((row) => {
        if (currentMessages.current.has(row.dataset.chatMessageId ?? ''))
          return false;
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > top && bounds.top < bottom;
      }),
    );
  }, [scroller]);

  useLayoutEffect(() => {
    if (!scroller || !isActive) return;
    updateVisibleLoading();
    const observer = new ResizeObserver((entries) => {
      updateVisibleLoading();
      let changed = false;
      entries.forEach(({ target }) => {
        if (!(target instanceof HTMLElement)) return;
        const id = target.dataset.chatMessageId;
        if (
          id &&
          byId.has(id) &&
          !target.hasAttribute('data-chat-row-loading')
        ) {
          const height = target.getBoundingClientRect().height;
          const previous = heights.current.get(id);
          if (previous !== undefined && Math.abs(previous - height) > 0.5)
            changed = true;
          if (height > 0) heights.current.set(id, height);
        } else if (target === scroller) {
          setViewportHeight(scroller.clientHeight);
          const size = `${scroller.clientWidth}:${scroller.clientHeight}`;
          if (
            viewportSize.current !== undefined &&
            viewportSize.current !== size
          ) {
            changed = true;
            // Composer resizing is not a request to leave the latest message.
            if (
              atBottom.current &&
              !seeking.current &&
              !scrollbarDragging.current
            )
              bottomRequest.current = true;
          }
          viewportSize.current = size;
        }
      });
      updateAway();
      reportLatestVisible();
      if (placementRequest.current || following.current) {
        settlePosition();
        return;
      }
      if (
        seeking.current ||
        scrollbarDragging.current ||
        !changed ||
        !ready.current ||
        positioning.current
      )
        return;
      positioning.current = true;
      settlePosition();
    });
    const rows = scroller.querySelectorAll<HTMLElement>(
      '[data-chat-message-id]',
    );
    rows.forEach((row) => {
      const id = row.dataset.chatMessageId;
      if (
        id &&
        byId.has(id) &&
        !row.hasAttribute('data-chat-row-loading') &&
        !heights.current.has(id)
      )
        heights.current.set(id, row.getBoundingClientRect().height);
      observer.observe(row);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [
    scroller,
    ids,
    range,
    isActive,
    settlePosition,
    byId,
    updateVisibleLoading,
    updateAway,
    reportLatestVisible,
  ]);

  useEffect(() => {
    const tail = messages.at(-1);
    if (tail && previousTail.current && tail !== previousTail.current)
      setHasNew(true);
    previousTail.current = tail;
  }, [messages]);

  const visibleIds = useMemo(() => {
    if (!range) return [];
    return ids.slice(
      Math.max(0, range.startIndex - first),
      range.endIndex - first + 1,
    );
  }, [range, ids, first]);
  useEffect(() => {
    if ((!seekLoading && !seekPending) || !scroller) return;
    if (!isActive) {
      setSeekLoading(false);
      setSeekPending(false);
      return;
    }
    if (isSeeking) return;
    // Keep rich-text mounting and its initial remeasurement behind one loading surface.
    let deadline: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const visibleRows = () => {
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      const bottom = top + scroller.clientHeight;
      return [
        ...scroller.querySelectorAll<HTMLElement>('[data-chat-message-id]'),
      ].filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > top && bounds.top < bottom;
      });
    };
    const settle = () => {
      clearTimeout(timer);
      const rows = visibleRows();
      if (
        !rows.length ||
        rows.some(
          (row) =>
            !byId.has(row.dataset.chatMessageId ?? '') ||
            row.hasAttribute('data-chat-seek-placeholder'),
        )
      ) {
        deadline = undefined;
        return;
      }
      deadline ??= performance.now() + 500;
      timer = setTimeout(
        () => {
          setSeekLoading(false);
          setSeekPending(false);
        },
        Math.max(0, Math.min(150, deadline - performance.now())),
      );
    };
    const observer = new ResizeObserver((entries) => {
      const visible = new Set<Element>(visibleRows());
      if (
        entries.some(({ target }) => target === scroller || visible.has(target))
      )
        settle();
    });
    scroller
      .querySelectorAll('[data-chat-message-id]')
      .forEach((row) => observer.observe(row));
    observer.observe(scroller);
    scroller.addEventListener('scroll', settle, { passive: true });
    settle();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      scroller.removeEventListener('scroll', settle);
    };
  }, [seekLoading, seekPending, scroller, isActive, isSeeking, byId, range]);
  useEffect(() => {
    if (!isActive || !isHistoryReady || isHistoryLoading || isSeeking) return;
    const wanted = new Set([
      ...visibleIds,
      ...(search?.target ? [search.target] : []),
      ...(placementRequest.current && anchor.current
        ? [anchor.current.messageId]
        : []),
    ]);
    historyPages.forEach((page) => {
      if (!page.loaded && page.messageIds.some((id) => wanted.has(id)))
        onLoadHistoryPage?.(page);
    });
    if (visibleIds.length && !search && !localFind)
      onVisibleMessagesChange?.(visibleIds);
  }, [
    visibleIds,
    historyPages,
    isActive,
    isHistoryReady,
    isHistoryLoading,
    onLoadHistoryPage,
    onVisibleMessagesChange,
    search,
    localFind,
    isSeeking,
  ]);

  const loadOlder = useCallback(() => {
    if (
      isActive &&
      ready.current &&
      !positioning.current &&
      !seeking.current &&
      allowHistoryLoad.current &&
      scroller !== null &&
      scroller.scrollTop < 200 &&
      hasOlderHistory &&
      !isLoadingOlderHistory &&
      !olderHistoryError &&
      !search
    ) {
      onLoadOlderHistory?.();
    }
  }, [
    isActive,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryError,
    onLoadOlderHistory,
    search,
    scroller,
  ]);

  useEffect(() => {
    if (
      !scroller ||
      !isActive ||
      !isHistoryReady ||
      isHistoryLoading ||
      isLoading ||
      !hasOlderHistory ||
      isLoadingOlderHistory ||
      olderHistoryError ||
      historyPageError ||
      search ||
      localFind ||
      isSeeking ||
      viewportHeight <= 0 ||
      (ids.length > 0 && listHeight <= 0)
    )
      return;
    const timer = setTimeout(() => {
      if (
        (ids.length > 0 && !ready.current) ||
        positioning.current ||
        seeking.current ||
        scrollbarDragging.current ||
        scroller.clientHeight <= 0 ||
        scroller.scrollHeight > scroller.clientHeight + 1 ||
        ids.some((id) => !currentMessages.current.has(id))
      )
        return;
      fillingLatest.current = !allowHistoryLoad.current;
      onLoadOlderHistory?.();
    }, 150);
    return () => clearTimeout(timer);
  }, [
    scroller,
    isActive,
    isHistoryReady,
    isHistoryLoading,
    isLoading,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryError,
    historyPageError,
    search,
    localFind,
    isSeeking,
    viewportHeight,
    listHeight,
    layoutVersion,
    ids,
    historyPages,
    onLoadOlderHistory,
  ]);

  useEffect(() => {
    if (!scroller || !isActive) return;
    const reveal = (event: Event) => {
      event.preventDefault();
      setSearchError(false);
      scanned.current.clear();
      setSearch({
        source: (event as CustomEvent<{ source?: CanvasSearchSource }>).detail
          ?.source,
      });
    };
    const finish = () => {
      takeControl();
      setSearch(undefined);
    };
    const openFind = () => {
      setLocalFind(true);
      setSearch({});
    };
    const closeFind = () => {
      takeControl();
      setLocalFind(false);
      setSearch(undefined);
    };
    scroller.addEventListener('chat-reveal-search', reveal);
    scroller.addEventListener('chat-search-finished', finish);
    scroller.addEventListener('chat-find-open', openFind);
    scroller.addEventListener('chat-find-close', closeFind);
    return () => {
      scroller.removeEventListener('chat-reveal-search', reveal);
      scroller.removeEventListener('chat-search-finished', finish);
      scroller.removeEventListener('chat-find-open', openFind);
      scroller.removeEventListener('chat-find-close', closeFind);
      setSearch(undefined);
      setLocalFind(false);
    };
  }, [scroller, isActive, takeControl]);

  useEffect(() => {
    if (
      !search ||
      search.target ||
      !isActive ||
      isLoadingOlderHistory ||
      olderHistoryError ||
      historyPageError
    )
      return;
    let cancelled = false;
    void (async () => {
      if (search.source) {
        for (const message of messages) {
          if (scanned.current.has(message.id)) continue;
          const texts =
            message.role === 'user'
              ? [message.content]
              : message.role === 'assistant'
                ? message.segments.flatMap((part) =>
                    part.kind === 'text' ? [part.text] : [],
                  )
                : [];
          for (const text of texts) {
            if ((await hashSearchSource(text)) === search.source.hash) {
              if (!cancelled) {
                setSearch({ ...search, target: message.id });
                jump(message.id);
              }
              return;
            }
            if (cancelled) return;
          }
          scanned.current.add(message.id);
        }
      }
      if (cancelled) return;
      if (search.source && !localFind) onVisibleMessagesChange?.(visibleIds);
      const missing = historyPages.find(
        (page) =>
          !page.loaded &&
          (!search.source ||
            page.messageIds.some((id) => !scanned.current.has(id))),
      );
      if (missing) {
        onLoadHistoryPage?.(missing);
        return;
      }
      if (hasOlderHistory) {
        onLoadOlderHistory?.();
        return;
      }
      if (search.source) setSearchError(true);
      else setSearch({ ...search, target: ids[0] });
    })().catch((error: unknown) => {
      console.warn('[MessageList] search navigation failed', error);
      if (!cancelled) setSearchError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    search,
    isActive,
    messages,
    historyPages,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryError,
    historyPageError,
    onLoadHistoryPage,
    onLoadOlderHistory,
    ids,
    jump,
    visibleIds,
    onVisibleMessagesChange,
    localFind,
  ]);

  const streamingAssistantId = (() => {
    if (!isLoading) return undefined;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === 'user') return undefined;
      if (message?.role === 'assistant') return message.id;
    }
    return undefined;
  })();
  const renderMessage = (_index: number, id: string) => {
    const message = byId.get(id);
    const next = byId.get(ids[_index - first + 1] ?? '');
    if (!message)
      return (
        <div
          data-chat-message-id={id}
          data-chat-row-loading
          className="flex items-center overflow-hidden px-3"
          style={{ height: heights.current.get(id) ?? 120 }}
          aria-busy="true"
        >
          <StaticPlaceholder />
        </div>
      );
    return (
      <div data-chat-message-id={id} className="flow-root px-3 pb-1">
        {message.role === 'user' ? (
          <UserMessage
            content={message.content}
            isFirst={id === ids[0]}
            quotedComments={message.quotedComments}
            inputKind={message.inputKind}
            inkInterpretation={message.inkInterpretation}
            attachments={message.attachments}
            selectedNodeIds={message.selectedNodeIds}
            selectedStrokeIds={message.selectedStrokeIds}
            invokedSkills={message.invokedSkills}
          />
        ) : message.role === 'assistant' ? (
          <AIMessage
            messageId={id}
            segments={message.segments}
            isStreaming={id === streamingAssistantId}
            endStatus={next?.role === 'status' ? next.status : undefined}
            hideActions={hideAIActions}
            enableComments={isActive}
          />
        ) : (
          <StatusMessage
            status={message.status}
            detail={message.detail}
            onRetry={onRetry}
          />
        )}
      </div>
    );
  };

  const pageError = historyPageError ?? olderHistoryError;
  const showScrollLoading =
    !pageError && (seekLoading || seekPending || visibleMissing);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {pageError ? (
        <div
          role="alert"
          className="border-edge-default bg-surface text-danger absolute top-2 left-1/2 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center justify-center gap-2 rounded-md border px-3 py-1 text-xs shadow-lg"
        >
          <span>{pageError}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={historyPageError ? onRetryHistoryPage : onLoadOlderHistory}
          >
            {t('messages.retry')}
          </Button>
        </div>
      ) : null}
      {isLoadingOlderHistory && !showScrollLoading ? (
        <div
          role="status"
          className="bg-surface text-fg-muted pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-md px-3 py-1 text-center text-xs"
        >
          {t('chat.loadingEarlierTurns')}
        </div>
      ) : null}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Keyboard handlers extend native scrolling to unloaded history. */}
      <div
        ref={setScroller}
        role="log"
        aria-label={t('messages.listLabel')}
        aria-live="off"
        data-chat-thread-root
        data-chat-thread-id={threadId}
        data-chat-virtual-search={search ? true : undefined}
        data-chat-has-older={hasOlderHistory || undefined}
        data-chat-history-loading={
          isHistoryLoading ||
          isLoadingOlderHistory ||
          (search && !search.target) ||
          undefined
        }
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The conversation viewport supports native keyboard scrolling.
        tabIndex={0}
        className="huabu-scrollbar [container-type:size] min-h-0 flex-1 [scrollbar-gutter:stable] overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
        onScroll={() => {
          if (!scroller) return;
          updateVisibleLoading();
          const distance = Math.abs(scroller.scrollTop - lastScrollTop.current);
          lastScrollTop.current = scroller.scrollTop;
          if (!ready.current || !isActive) return;
          if (
            allowHistoryLoad.current &&
            !placementRequest.current &&
            !positioning.current &&
            performance.now() >= anchorCorrectionUntil.current &&
            scroller.clientHeight > 0 &&
            distance >= scroller.clientHeight
          )
            setSeekLoading(true);
          const nowAtBottom =
            scroller.scrollHeight -
              scroller.scrollTop -
              scroller.clientHeight <=
            50;
          atBottom.current = nowAtBottom;
          updateAway();
          reportLatestVisible();
          if (nowAtBottom) setHasNew(false);
          saveAnchor();
          if (scroller.scrollTop < 200) loadOlder();
        }}
        onWheelCapture={(event) => {
          if (event.deltaY < 0 || !following.current) takeControl();
          if (event.deltaY < 0) loadOlder();
        }}
        onTouchStartCapture={(event) => {
          takeControl();
          touchY.current =
            event.touches.length === 1 ? event.touches[0]?.clientY : undefined;
        }}
        onTouchMoveCapture={(event) => {
          const nextY =
            event.touches.length === 1 ? event.touches[0]?.clientY : undefined;
          if (
            nextY !== undefined &&
            touchY.current !== undefined &&
            nextY > touchY.current
          )
            loadOlder();
          touchY.current = nextY;
        }}
        onPointerDownCapture={(event) => {
          takeControl();
          scrollbarDragging.current = event.target === scroller;
        }}
        onKeyDownCapture={takeControl}
        onKeyDown={(event) => {
          if (
            !event.defaultPrevented &&
            ['ArrowUp', 'PageUp', 'Home'].includes(event.key) &&
            event.target instanceof HTMLElement &&
            !event.target.closest(
              'input, textarea, select, [contenteditable="true"]',
            )
          )
            loadOlder();
        }}
      >
        {showScrollLoading ? (
          <div className="pointer-events-none sticky top-0 z-10 h-0">
            <div
              data-chat-scroll-loading={seekLoading || undefined}
              data-chat-loading-indicator
              className={`${seekLoading ? 'bg-surface' : ''} absolute inset-x-0 top-0 flex h-[100cqh] items-center justify-center`}
            >
              <span className="bg-surface rounded-md px-3 py-1">
                <Loading
                  variant="spinner"
                  layout="inline"
                  message={t('status.loading')}
                />
              </span>
            </div>
          </div>
        ) : null}
        {materializeSearch ? (
          ids.map((id, index) => (
            <div key={id}>{renderMessage(first + index, id)}</div>
          ))
        ) : scroller ? (
          <Virtuoso
            ref={list}
            components={VIRTUAL_COMPONENTS}
            context={indexState}
            scrollSeekConfiguration={scrollSeekConfiguration}
            customScrollParent={scroller}
            data={ids}
            firstItemIndex={first}
            computeItemKey={(_index, id) => id}
            defaultItemHeight={120}
            totalListHeightChanged={setListHeight}
            increaseViewportBy={{ top: 400, bottom: 400 }}
            followOutput={false}
            rangeChanged={setRange}
            startReached={loadOlder}
            itemContent={renderMessage}
          />
        ) : null}
        {isLoading && !streamingAssistantId ? (
          <div className="px-3">
            <div className="ml-1 px-4 py-2">
              <ThinkingIndicator />
            </div>
          </div>
        ) : null}
        {isHistoryLoading && !ids.length ? (
          <div className="px-3 py-2">
            <Loading variant="skeleton" layout="bare" />
          </div>
        ) : null}
      </div>
      {searchError ? (
        <div
          role="status"
          className="bg-surface text-fg-muted absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-md px-3 py-1 text-xs"
        >
          {t('chat.readingPositionUnavailable')}
        </div>
      ) : null}
      {!isHistoryLoading && !isLoading && ids.length === 0 ? (
        <div
          className="text-fg-subtle pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-xs"
          data-chat-empty-disclaimer
        >
          {t('chat.aiContentDisclaimer')}
        </div>
      ) : null}
      {away ? (
        <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2">
          <Button
            variant="outline"
            shape="pill"
            tone="neutral"
            size="field"
            iconOnly={!hasNew}
            title={t('chat.backToBottom')}
            aria-label={t(hasNew ? 'chat.newMessage' : 'chat.backToBottom')}
            className="h-8 text-xs shadow-sm"
            onClick={() => {
              scroller?.focus({ preventScroll: true });
              following.current = true;
              jump();
            }}
          >
            {hasNew ? t('chat.newMessage') : null}
            <ArrowDown aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
