// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import deepEqual from 'fast-deep-equal';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { createId } from '@huabu/shared';
import { settleInkInterpretation } from '@huabu/shared/ink-interpretation';

import { ApiError } from '@/api/_client';
import { agentApi } from '@/api/agent';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import {
  HISTORY_PAGE_TURNS,
  MAX_HISTORY_PAGES,
} from '@/store/chatHistoryCache';
import {
  selectThreadHistoryLoaded,
  selectThreadHistoryPageState,
  selectThreadLastAction,
  selectThreadMessages,
  selectThreadIsLoading,
  useChatStore,
} from '@/store/chatStore';
import {
  ConversationIntegrityError,
  validateConversationView,
  useConversationOwnerSource,
} from '@/store/conversationOwner';
import { refreshConversationTitleAfterStream } from '@/store/conversationTitleStore';
import {
  messageListViewKey,
  remapMessageListScrollAnchor,
} from '@/store/previewWorkspace/scrollMemory';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { claimAgentStream } from './agentStreamCoordinator';
import {
  clearInkInterpretationStream,
  hasUnreconciledAgentTurn,
  inkTurnOutcome,
  observeAgentTurnAcceptance,
  reconcileAgentTurnAfterReconnect,
  settleTurnInkInterpretation,
  settleAgentTurnQueue,
} from './agentTurnController';
import { handleStreamEvent } from './useAgentStream';

import type { ChatSession } from './useChatSession';
import type { ChatMessage } from '../store/chatTypes';
import type { ChatHistoryPage } from '@/store/chatHistoryCache';
import type {
  AgentHistoryDisplayTurn,
  AgentHistoryPageResponse,
  AgentStreamEvent,
  ChatHistoryItem,
} from '@huabu/shared';

/**
 * Roles the transcript renderer still understands. Anything else in a
 * persisted transcript belongs to a removed feature and is dropped on load.
 */
const KNOWN_HISTORY_ROLES = new Set<string>(['user', 'assistant', 'status']);
const INITIAL_ATTACH_RETRY_MS = 500;
const MAX_ATTACH_RETRY_MS = 10_000;
const attachRetryDelayByThread = new Map<string, number>();

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      window.clearTimeout(timeout);
      finish();
    };
    const timeout = window.setTimeout(finish, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function historyItemsToMessages(
  turnId: string,
  messages: ChatHistoryItem[],
  activeMessageStart: number | undefined,
): ChatMessage[] {
  return messages.flatMap((message, index): ChatMessage[] => {
    const id = `${turnId}:${index}`;
    const historyTurnActive =
      activeMessageStart !== undefined && index >= activeMessageStart;
    if (!KNOWN_HISTORY_ROLES.has(message.role)) return [];

    if (message.role === 'status') {
      return [
        {
          id,
          historyTurnId: turnId,
          historyTurnActive,
          role: 'status',
          status: message.status,
          detail: message.detail,
        },
      ];
    }

    const attachments =
      message.attachments && message.attachments.length > 0
        ? { attachments: message.attachments }
        : {};
    const selectedNodeIds =
      message.selectedNodeIds && message.selectedNodeIds.length > 0
        ? { selectedNodeIds: message.selectedNodeIds }
        : {};

    if (message.role === 'assistant') {
      return [
        {
          id,
          historyTurnId: turnId,
          historyTurnActive,
          role: 'assistant',
          segments: message.parts,
          ...attachments,
          ...selectedNodeIds,
        },
      ];
    }

    return [
      {
        id,
        historyTurnId: turnId,
        historyTurnActive,
        role: 'user',
        content: message.content || '',
        ...(message.quotedComments?.length
          ? { quotedComments: message.quotedComments }
          : {}),
        ...(message.inputKind ? { inputKind: message.inputKind } : {}),
        ...(message.inputKind === 'ink-intent'
          ? {
              inkInterpretation: historyTurnActive
                ? (message.inkInterpretation ?? { state: 'pending' as const })
                : message.inkInterpretation
                  ? settleInkInterpretation(message.inkInterpretation, 'done')
                  : { state: 'legacy' as const },
            }
          : {}),
        ...(message.groundingVisual
          ? { groundingVisual: message.groundingVisual }
          : {}),
        ...(message.inkResources?.length
          ? { inkResources: message.inkResources }
          : {}),
        ...attachments,
        ...selectedNodeIds,
        ...(message.selectedStrokeIds && message.selectedStrokeIds.length > 0
          ? { selectedStrokeIds: message.selectedStrokeIds }
          : {}),
        ...(message.invokedSkills && message.invokedSkills.length > 0
          ? { invokedSkills: message.invokedSkills }
          : {}),
      },
    ];
  });
}

function historyTurnsToMessages(
  turns: AgentHistoryDisplayTurn[],
): ChatMessage[] {
  return turns.flatMap((turn) =>
    historyItemsToMessages(
      turn.id,
      turn.messages,
      turn.active === true ? (turn.activeMessageStart ?? 0) : undefined,
    ),
  );
}

function applyInitialHistoryPage(response: AgentHistoryPageResponse): void {
  const state = useChatStore.getState();
  const messages = historyTurnsToMessages(response.turns);
  state.setMessages(response.threadId, messages);
  state.setHistoryPages(response.threadId, [
    {
      limit: HISTORY_PAGE_TURNS,
      messageIds: messages.map((message) => message.id),
      loaded: true,
    },
  ]);
  state.setHistoryPageState(response.threadId, {
    before: response.before ?? null,
    hasOlder: response.hasMore,
    loadingOlder: false,
    error: null,
  });
  state.setHistoryLoaded(response.threadId, true);
  state.setHistoryError(response.threadId, null);
}

interface LatestHistoryWindow {
  response: AgentHistoryPageResponse;
  hadCachedHistory: boolean;
  overlapsCache: boolean;
  pages: ChatHistoryPage[];
}

async function fetchLatestHistoryWindow(
  threadId: string,
  canvasId: string,
  limit: number,
): Promise<LatestHistoryWindow> {
  const cachedTurnIds = new Set(
    selectThreadMessages(useChatStore.getState(), threadId).flatMap(
      (message) => (message.historyTurnId ? [message.historyTurnId] : []),
    ),
  );
  const cachedPages =
    useChatStore.getState().threadsById[threadId]?.historyPages ?? [];
  const cachedMessageIds = new Set(
    cachedPages.flatMap((page) => page.messageIds),
  );
  const overlaps = (turns: AgentHistoryDisplayTurn[]) =>
    turns.some((turn) => cachedTurnIds.has(turn.id)) ||
    historyTurnsToMessages(turns).some((message) =>
      cachedMessageIds.has(message.id),
    );
  const hadCachedHistory = cachedTurnIds.size > 0 || cachedMessageIds.size > 0;
  const localTurnCount = selectThreadMessages(
    useChatStore.getState(),
    threadId,
  ).filter(
    (message) => message.role === 'user' && !message.historyTurnId,
  ).length;
  const latest = await agentApi.fetchHistoryPage(threadId, canvasId, limit);
  const latestPage = useChatStore
    .getState()
    .threadsById[
      threadId
    ]?.historyPages?.find((page) => page.before === undefined);
  const boundary = latestPage?.messageIds[0];
  const pages: ChatHistoryPage[] = [
    {
      limit,
      messageIds: historyTurnsToMessages(latest.turns).map((m) => m.id),
      loaded: true,
    },
  ];
  let turns = latest.turns;
  let before = latest.before;
  let hasMore = latest.hasMore;
  let overlapsCache = overlaps(turns);
  let fetchedTurnCount = turns.length;

  while (
    ((hadCachedHistory &&
      (boundary
        ? !pages.some((page) => page.messageIds.includes(boundary))
        : !overlapsCache)) ||
      fetchedTurnCount < localTurnCount) &&
    hasMore &&
    before
  ) {
    const older = await agentApi.fetchHistoryPage(
      threadId,
      canvasId,
      limit,
      before,
    );
    pages.unshift({
      before,
      limit,
      messageIds: historyTurnsToMessages(older.turns).map((m) => m.id),
      loaded: true,
    });
    turns = [...older.turns, ...turns];
    fetchedTurnCount += older.turns.length;
    if (pages.length > MAX_HISTORY_PAGES) {
      const middle = pages[1];
      if (middle) middle.loaded = false;
      const retained = new Set(
        pages.filter((page) => page.loaded).flatMap((page) => page.messageIds),
      );
      turns = turns.filter((turn) => retained.has(`${turn.id}:0`));
    }
    before = older.before;
    hasMore = older.hasMore;
    overlapsCache ||= overlaps(older.turns);
  }

  return {
    response: { ...latest, turns, before, hasMore },
    hadCachedHistory,
    overlapsCache,
    pages,
  };
}

function applyLatestHistoryWindow(
  window: LatestHistoryWindow,
  canvasId: string,
): void {
  const current = selectThreadMessages(
    useChatStore.getState(),
    window.response.threadId,
  );
  const incoming = historyTurnsToMessages(window.response.turns);
  const aliases = new Map<string, string>();
  const content = (message: ChatMessage) =>
    message.role === 'user'
      ? [
          message.role,
          message.content,
          message.quotedComments,
          message.attachments,
        ]
      : message.role === 'assistant'
        ? [message.role, message.segments]
        : [message.role, message.status, message.detail];
  let candidate = incoming.length - 1;
  for (const message of [...current].reverse()) {
    if (message.historyTurnId) break;
    for (let index = candidate; index >= 0; index--) {
      const persisted = incoming[index];
      if (persisted && deepEqual(content(message), content(persisted))) {
        aliases.set(message.id, persisted.id);
        candidate = index - 1;
        break;
      }
    }
  }
  remapMessageListScrollAnchor(
    messageListViewKey(canvasId, window.response.threadId),
    aliases,
  );
  if (window.hadCachedHistory && window.overlapsCache) {
    const state = useChatStore.getState();
    const pages =
      state.threadsById[window.response.threadId]?.historyPages ?? [];
    const incomingIds = new Set(
      window.pages.flatMap((page) => page.messageIds),
    );
    const overlap = pages.findIndex((page) =>
      page.messageIds.some((id) => incomingIds.has(id)),
    );
    const partial = overlap >= 0 ? pages[overlap] : undefined;
    const prefixIds =
      partial?.messageIds.filter((id) => !incomingIds.has(id)) ?? [];
    const preservedPages = [
      ...pages.slice(0, overlap < 0 ? pages.length : overlap),
      ...(partial?.before && prefixIds.length
        ? [{ ...partial, messageIds: prefixIds }]
        : []),
    ];
    state.setHistoryPages(window.response.threadId, [
      ...preservedPages,
      ...window.pages,
    ]);
    if (!preservedPages.length) {
      state.setHistoryPageState(window.response.threadId, {
        before: window.response.before ?? null,
        hasOlder: window.response.hasMore,
        loadingOlder: false,
        error: null,
      });
    }
    state.mergeLatestHistoryMessages(window.response.threadId, incoming);
    state.setHistoryLoaded(window.response.threadId, true);
    state.trimHistoryCache(
      window.response.threadId,
      state.threadsById[window.response.threadId]?.historyVisibleIds ?? [],
    );
    return;
  }
  applyInitialHistoryPage(window.response);
  useChatStore
    .getState()
    .setHistoryPages(window.response.threadId, window.pages);
  useChatStore.getState().trimHistoryCache(window.response.threadId, []);
}

export interface ChatHistoryWindow {
  loadOlderHistory: () => void;
  retryHistory: () => void;
  loadHistoryPage: (page: ChatHistoryPage) => void;
  historyPageError?: string;
  retryHistoryPage: () => void;
  updateHistoryViewport: (ids: string[]) => void;
  isCurrentOwnerHistory: boolean;
}

/**
 * Hook that loads chat history from the server and handles reconnection
 * to an active agent run after page refresh.
 *
 * @param session - The conversation to load. All reads and writes are
 *   addressed to `session.threadId`, so a reconnect on a backgrounded
 *   thread never paints into a different renderer.
 * @param setIsLoading - Setter from useAgentStream to reflect reconnect
 *   loading state. Takes an explicit `threadId` so reconnects on a
 *   backgrounded thread don't flip loading on the visible one.
 */
export function useChatHistory(
  session: ChatSession,
  setIsLoading: (threadId: string, loading: boolean) => void,
  previewTabId?: string,
): ChatHistoryWindow {
  const { threadId, canvasId } = session;
  const [historyViewId] = useState(() => createId('history-view'));
  const updateHistoryViewport = useCallback(
    (ids: string[]) => {
      useChatStore.getState().trimHistoryCache(threadId, ids, historyViewId);
    },
    [threadId, historyViewId],
  );
  const pendingPages = useRef(new Set<ChatHistoryPage>());
  const staleCursor = useRef<string | undefined>(undefined);
  const resetOnHydration = useRef(false);
  const [refreshFailure, setRefreshFailure] = useState<{
    threadId: string;
    message: string;
  }>();
  const refreshError =
    refreshFailure?.threadId === threadId ? refreshFailure.message : undefined;
  const setRefreshError = useCallback(
    (message?: string) => {
      setRefreshFailure(message ? { threadId, message } : undefined);
    },
    [threadId],
  );
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [pageFailure, setPageFailure] = useState<{
    threadId: string;
    message: string;
  }>();
  const isHistoryLoaded = useChatStore((state) =>
    selectThreadHistoryLoaded(state, threadId),
  );
  const addMessage = useChatStore((state) => state.addMessage);
  const historyError = useChatStore(
    (state) => state.threadsById[threadId]?.historyError ?? null,
  );
  const effectiveConversationView = session.conversationView;
  const ownerCanvasId =
    effectiveConversationView?.conversationOwner.canvasId || canvasId;
  const ownerNodeId =
    effectiveConversationView?.conversationOwner.nodeId ?? null;
  useLayoutEffect(() => {
    if (!threadId || !ownerCanvasId) return;
    return useChatStore.getState().retainHistoryView(threadId, historyViewId);
  }, [threadId, ownerCanvasId, historyViewId]);
  const reloadHistory = useCallback(() => {
    const state = useChatStore.getState();
    const thread = state.threadsById[threadId];
    if (
      thread?.isStreaming ||
      thread?.isPreparing ||
      hasUnreconciledAgentTurn(ownerCanvasId, threadId)
    ) {
      setRefreshError(
        'History changed. Finish the current turn before retrying the history reload.',
      );
      return;
    }
    resetOnHydration.current = true;
    staleCursor.current = undefined;
    setPageFailure(undefined);
    setRefreshError(undefined);
    state.setHistoryError(threadId, null);
    state.setHistoryLoaded(threadId, false);
  }, [threadId, ownerCanvasId, setRefreshError]);
  const ownerSource = useConversationOwnerSource(effectiveConversationView);
  const ownerStatus = ownerSource?.status;
  const ownerHistoryKey = effectiveConversationView
    ? JSON.stringify([
        ownerCanvasId,
        threadId,
        ownerSource?.invocationToken ?? null,
        ownerStatus,
      ])
    : null;
  const [hydratedOwnerKey, setHydratedOwnerKey] = useState<string | null>(null);
  const isStreaming = useChatStore((state) =>
    selectThreadIsLoading(state, threadId),
  );
  const needsOwnerRefresh =
    (ownerStatus === 'done' || ownerStatus === 'error') &&
    ownerHistoryKey !== hydratedOwnerKey;

  // A terminal token can change without a visible running transition.
  // Wait for canvasId to be available — on initial mount the canvas may
  // not have loaded yet, causing a request without canvasId that 404s.
  useEffect(() => {
    if (!ownerCanvasId) return;
    // Snapshot the thread we're loading for. If the user switches threads
    // mid-fetch, we still want to land the response on the originating
    // thread (cache survives navigation) rather than the current one.
    const tid = threadId;
    const loaded = selectThreadHistoryLoaded(useChatStore.getState(), tid);
    if (loaded && (!needsOwnerRefresh || isStreaming)) return;
    if (historyError) return;

    let cancelled = false;

    const currentState = useChatStore.getState();
    const action = selectThreadLastAction(currentState, tid);

    const fetchValidatedHistory = async () => {
      if (effectiveConversationView) {
        try {
          await validateConversationView(effectiveConversationView);
        } catch (error) {
          if (error instanceof ConversationIntegrityError) {
            if (previewTabId && canvasId === ownerCanvasId) {
              usePreviewWorkspaceStore.getState().closeTab(previewTabId);
              return;
            }
          }
          throw error;
        }
      }
      if (cancelled) return;
      if (resetOnHydration.current) {
        const response = await agentApi.fetchHistoryPage(
          tid,
          ownerCanvasId,
          HISTORY_PAGE_TURNS,
        );
        return {
          response,
          hadCachedHistory: false,
          overlapsCache: false,
          pages: [
            {
              limit: HISTORY_PAGE_TURNS,
              messageIds: historyTurnsToMessages(response.turns).map(
                (message) => message.id,
              ),
              loaded: true,
            },
          ],
        };
      }
      return fetchLatestHistoryWindow(tid, ownerCanvasId, HISTORY_PAGE_TURNS);
    };

    fetchValidatedHistory()
      .then((window) => {
        if (cancelled || !window) return;
        const res = window.response;
        resetOnHydration.current = false;

        // If the server returned a different threadId (fallback to latest),
        // update the client's threadMap so future requests use the correct id.
        const overrideTid =
          res.threadId && res.threadId !== tid ? res.threadId : null;
        const finalTid = overrideTid ?? tid;
        if (overrideTid && !effectiveConversationView && previewTabId) {
          usePreviewWorkspaceStore.getState().replaceTabTarget(previewTabId, {
            kind: 'chat',
            canvasId,
            threadId: overrideTid,
          });
          useChatStore.setState((state) => ({
            threadMap: {
              ...state.threadMap,
              [canvasId]: overrideTid,
            },
          }));
        }

        applyLatestHistoryWindow(
          { ...window, response: { ...res, threadId: finalTid } },
          ownerCanvasId,
        );
        setHydratedOwnerKey(ownerHistoryKey);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn(`Could not load ${action} history:`, err);
        useChatStore
          .getState()
          .setHistoryError(
            tid,
            err instanceof Error ? err.message : 'Failed to load history',
          );
      });

    return () => {
      cancelled = true;
    };
  }, [
    threadId,
    ownerCanvasId,
    effectiveConversationView,
    previewTabId,
    canvasId,
    historyError,
    isHistoryLoaded,
    isStreaming,
    needsOwnerRefresh,
    ownerHistoryKey,
  ]);

  const loadOlderHistory = useCallback(() => {
    if (!ownerCanvasId) return;
    if (staleCursor.current === threadId) {
      reloadHistory();
      return;
    }
    const pageState = selectThreadHistoryPageState(
      useChatStore.getState(),
      threadId,
    );
    if (
      pageState.isLoadingOlderHistory ||
      !pageState.hasOlderHistory ||
      !pageState.historyBefore
    ) {
      return;
    }
    const requestedBefore = pageState.historyBefore;
    const revision =
      useChatStore.getState().threadsById[threadId]?.historyRevision;
    useChatStore.getState().setHistoryPageState(threadId, {
      before: requestedBefore,
      hasOlder: true,
      loadingOlder: true,
      error: null,
    });
    void agentApi
      .fetchHistoryPage(
        threadId,
        ownerCanvasId,
        HISTORY_PAGE_TURNS,
        requestedBefore,
      )
      .then((response) => {
        const current = selectThreadHistoryPageState(
          useChatStore.getState(),
          threadId,
        );
        if (
          current.historyBefore !== requestedBefore ||
          useChatStore.getState().threadsById[threadId]?.historyRevision !==
            revision
        )
          return;
        const state = useChatStore.getState();
        const messages = historyTurnsToMessages(response.turns);
        state.setHistoryPages(threadId, [
          {
            before: requestedBefore,
            limit: HISTORY_PAGE_TURNS,
            messageIds: messages.map((message) => message.id),
            loaded: true,
          },
          ...(state.threadsById[threadId]?.historyPages ?? []),
        ]);
        state.prependHistoryMessages(threadId, messages);
        state.setHistoryPageState(threadId, {
          before: response.before ?? null,
          hasOlder: response.hasMore,
          loadingOlder: false,
          error: null,
        });
      })
      .catch((error: unknown) => {
        const current = selectThreadHistoryPageState(
          useChatStore.getState(),
          threadId,
        );
        if (
          current.historyBefore !== requestedBefore ||
          useChatStore.getState().threadsById[threadId]?.historyRevision !==
            revision
        )
          return;
        if (error instanceof ApiError && error.status === 409) {
          staleCursor.current = threadId;
        }
        useChatStore.getState().setHistoryPageState(threadId, {
          before: requestedBefore,
          hasOlder: true,
          loadingOlder: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to load earlier turns',
        });
      });
  }, [ownerCanvasId, threadId, reloadHistory]);

  const loadHistoryPage = useCallback(
    (page: ChatHistoryPage) => {
      const thread = useChatStore.getState().threadsById[threadId];
      if (
        !ownerCanvasId ||
        page.loaded ||
        !thread?.historyPages?.includes(page) ||
        pendingPages.current.has(page) ||
        pageFailure?.threadId === threadId
      )
        return;
      const revision = thread.historyRevision;
      const isCurrentPage = () => {
        const current = useChatStore.getState().threadsById[threadId];
        return (
          current?.historyRevision === revision &&
          current?.historyPages?.includes(page)
        );
      };
      pendingPages.current.add(page);
      void agentApi
        .fetchHistoryPage(threadId, ownerCanvasId, page.limit, page.before)
        .then((response) => {
          if (!isCurrentPage()) return;
          const messages = historyTurnsToMessages(response.turns);
          const ids = new Set(messages.map((message) => message.id));
          if (page.messageIds.some((id) => !ids.has(id))) {
            staleCursor.current = threadId;
            throw new Error(
              'History page changed. Reload the conversation to continue.',
            );
          }
          useChatStore.getState().refillHistoryPage(threadId, page, messages);
        })
        .catch((error: unknown) => {
          if (!isCurrentPage()) return;
          if (error instanceof ApiError && error.status === 409)
            staleCursor.current = threadId;
          console.warn('[useChatHistory] page refill failed', error);
          setPageFailure({
            threadId,
            message:
              error instanceof Error
                ? error.message
                : 'Failed to load history page',
          });
        })
        .finally(() => pendingPages.current.delete(page));
    },
    [ownerCanvasId, threadId, pageFailure],
  );

  const completedTurnId = useChatStore(
    (state) => state.threadsById[threadId]?.completedTurnId,
  );
  const streaming = useChatStore(
    (state) => state.threadsById[threadId]?.isStreaming,
  );
  useEffect(() => {
    if (!completedTurnId || streaming || !ownerCanvasId || !isHistoryLoaded)
      return;
    let cancelled = false;
    const original = selectThreadMessages(useChatStore.getState(), threadId);
    setRefreshError(undefined);
    void fetchLatestHistoryWindow(threadId, ownerCanvasId, HISTORY_PAGE_TURNS)
      .then((window) => {
        const current = useChatStore.getState().threadsById[threadId];
        if (
          cancelled ||
          !current?.historyLoaded ||
          current?.isStreaming ||
          current?.isPreparing ||
          current?.completedTurnId !== completedTurnId ||
          current?.messages.at(-1) !== original.at(-1)
        )
          return;
        const localUser = [...original]
          .reverse()
          .find((message) => message.role === 'user' && !message.historyTurnId);
        const lastPersistedTurn = [...original]
          .reverse()
          .find((message) => message.historyTurnId)?.historyTurnId;
        const lastTurn = window.response.turns.at(-1);
        const persistedUser = [...(lastTurn?.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'user');
        if (
          localUser?.role === 'user' &&
          (lastTurn?.active ||
            lastTurn?.id === lastPersistedTurn ||
            persistedUser?.role !== 'user' ||
            persistedUser.content !== localUser.content)
        ) {
          throw new Error(
            'The completed turn is not available in history yet. Your messages are retained; retry to refresh.',
          );
        }
        applyLatestHistoryWindow(window, ownerCanvasId);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn(
            '[useChatHistory] completed history refresh failed',
            error,
          );
          setRefreshError(
            error instanceof Error
              ? error.message
              : 'Failed to refresh completed history',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    completedTurnId,
    streaming,
    ownerCanvasId,
    threadId,
    isHistoryLoaded,
    refreshNonce,
    setRefreshError,
  ]);

  // Try to reconnect to an active server-side run after history is loaded.
  // This handles the page-refresh case: events buffered during the refresh
  // are replayed, then live streaming resumes.
  useEffect(() => {
    if (!isHistoryLoaded || !threadId || !ownerCanvasId) return;

    const msgs = selectThreadMessages(useChatStore.getState(), threadId);
    const lastMessage = msgs[msgs.length - 1];
    const historyLooksIncomplete =
      lastMessage?.role === 'user' || lastMessage?.historyTurnActive === true;
    const hasOutstandingRequest = hasUnreconciledAgentTurn(
      ownerCanvasId,
      threadId,
    );
    if (
      ownerStatus !== 'running' &&
      !historyLooksIncomplete &&
      !hasOutstandingRequest
    )
      return;

    let cancelled = false;
    const ownerThreadId = threadId;
    const ownerView = effectiveConversationView;
    const claim = claimAgentStream(ownerCanvasId, ownerThreadId, 'attach');
    if (!claim) return;
    let queueCompletedNormally = false;

    const tryReconnect = async () => {
      if (ownerView) {
        try {
          await validateConversationView(ownerView);
        } catch (error) {
          if (error instanceof ConversationIntegrityError) {
            if (previewTabId) {
              usePreviewWorkspaceStore.getState().closeTab(previewTabId);
            }
            return;
          }
          throw error;
        }
      }
      if (cancelled) return;

      const refreshed = await fetchLatestHistoryWindow(
        ownerThreadId,
        ownerCanvasId,
        HISTORY_PAGE_TURNS,
      );
      if (cancelled) return;
      applyLatestHistoryWindow(refreshed, ownerCanvasId);

      const assistantId = createId('message');
      const userMessageId = [
        ...selectThreadMessages(useChatStore.getState(), ownerThreadId),
      ]
        .reverse()
        .find((message) => message.role === 'user')?.id;
      const streamContext = {
        threadId: ownerThreadId,
        assistantId,
        userMessageId,
      };
      // Flag set to true once we know the server has an active run
      let streaming = false;
      let outcome: 'done' | 'error' | 'interrupted' | undefined;
      const refreshObservation = () => {
        if (!ownerView) return;
        void Promise.all([
          useAcpThreadChangesStore
            .getState()
            .load(ownerCanvasId, ownerThreadId),
        ]).catch((error) =>
          console.error('[useChatHistory] observation refresh failed', error),
        );
      };

      // The reconnect event buffer replays the active Tier-1 projection.
      // Keep the active request and every persisted part of its display group.
      const clearStaleMessages = () => {
        const current = selectThreadMessages(
          useChatStore.getState(),
          ownerThreadId,
        );
        useChatStore.getState().setMessages(
          ownerThreadId,
          current.filter(
            (message) =>
              message.historyTurnActive !== true || message.role === 'user',
          ),
        );
      };

      const result = await agentApi
        .reconnectStream(
          ownerThreadId,
          ownerCanvasId,
          {
            onAccepted: (accepted) => {
              if (cancelled) return;
              observeAgentTurnAcceptance(ownerCanvasId, accepted);
            },
            onEvent: (event: AgentStreamEvent) => {
              if (cancelled) return;
              if (event.type === 'done') {
                outcome = inkTurnOutcome(event.data.meta?.stopReason);
                queueCompletedNormally = outcome === 'done';
              }
              if (!streaming) {
                streaming = true;
                if (!effectiveConversationView)
                  refreshConversationTitleAfterStream(
                    ownerCanvasId,
                    ownerThreadId,
                  );
                setIsLoading(ownerThreadId, true);
                clearStaleMessages();
              }
              handleStreamEvent(event, {
                ...streamContext,
                titleCanvasId: effectiveConversationView
                  ? undefined
                  : ownerCanvasId,
              });
            },
            onError: (err) => {
              if (cancelled) return;
              outcome = 'error';
              queueCompletedNormally = false;
              settleTurnInkInterpretation(streamContext, 'error');
              addMessage(ownerThreadId, {
                id: createId('status'),
                role: 'status',
                status: 'error',
                detail: err.message,
              });
              setIsLoading(ownerThreadId, false);
              refreshObservation();
            },
            onComplete: () => {
              if (cancelled) return;
              outcome ??= 'done';
              settleTurnInkInterpretation(streamContext, outcome);
              if (!effectiveConversationView)
                refreshConversationTitleAfterStream(
                  ownerCanvasId,
                  ownerThreadId,
                );
              setIsLoading(ownerThreadId, false);
              refreshObservation();
            },
          },
          claim.signal,
        )
        .finally(() => clearInkInterpretationStream(streamContext));

      if (result.status !== 'completed') queueCompletedNormally = false;
      if (result.status === 'inactive' && !cancelled) {
        outcome = 'interrupted';
        settleTurnInkInterpretation(streamContext, 'interrupted');
      }
      if (result.status !== 'aborted' && !cancelled) {
        await reconcileAgentTurnAfterReconnect(ownerCanvasId, ownerThreadId);
        if (cancelled) return;
        const finalHistory = await fetchLatestHistoryWindow(
          ownerThreadId,
          ownerCanvasId,
          HISTORY_PAGE_TURNS,
        );
        if (!cancelled) {
          applyLatestHistoryWindow(finalHistory, ownerCanvasId);
          if (outcome) settleTurnInkInterpretation(streamContext, outcome);
          setIsLoading(ownerThreadId, false);
        }
      }
      if (result.status !== 'aborted') {
        attachRetryDelayByThread.delete(ownerThreadId);
      }
    };

    void tryReconnect()
      .catch(async (error) => {
        queueCompletedNormally = false;
        if (cancelled || claim.signal.aborted) return;
        console.error('[useChatHistory] reconnect failed', error);
        const ownerStillRunning = ownerStatus === 'running';
        if (
          ownerStillRunning ||
          historyLooksIncomplete ||
          hasOutstandingRequest
        ) {
          const delay =
            attachRetryDelayByThread.get(ownerThreadId) ??
            INITIAL_ATTACH_RETRY_MS;
          attachRetryDelayByThread.set(
            ownerThreadId,
            Math.min(delay * 2, MAX_ATTACH_RETRY_MS),
          );
          await waitForRetry(delay, claim.signal);
        }
        if (cancelled || claim.signal.aborted) return;
        useChatStore.getState().setHistoryLoaded(ownerThreadId, false);
        setIsLoading(ownerThreadId, false);
      })
      .finally(() => {
        claim.release();
        settleAgentTurnQueue(
          { threadId: ownerThreadId, ownerCanvasId },
          !cancelled && queueCompletedNormally,
        );
      });

    return () => {
      cancelled = true;
      claim.release();
    };
  }, [
    isHistoryLoaded,
    threadId,
    ownerCanvasId,
    ownerNodeId,
    ownerStatus,
    effectiveConversationView,
    previewTabId,
    addMessage,
    setIsLoading,
  ]);

  const retryHistory = useCallback(() => {
    useChatStore.getState().setHistoryError(threadId, null);
  }, [threadId]);

  return {
    updateHistoryViewport,
    loadOlderHistory,
    retryHistory,
    loadHistoryPage,
    historyPageError:
      pageFailure?.threadId === threadId ? pageFailure.message : refreshError,
    retryHistoryPage: () => {
      if (staleCursor.current === threadId) {
        reloadHistory();
        return;
      }
      setPageFailure(undefined);
      if (refreshError) setRefreshNonce((nonce) => nonce + 1);
    },
    isCurrentOwnerHistory:
      isHistoryLoaded && !historyError && hydratedOwnerKey === ownerHistoryKey,
  };
}
