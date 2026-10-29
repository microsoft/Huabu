// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useState } from 'react';

import { createId } from '@huabu/shared';
import { settleInkInterpretation } from '@huabu/shared/ink-interpretation';

import { ApiError } from '@/api/_client';
import { agentApi } from '@/api/agent';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import { useChatPreferencesStore } from '@/store/chatPreferencesStore';
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
  state.setMessages(response.threadId, historyTurnsToMessages(response.turns));
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
  const hadCachedHistory = cachedTurnIds.size > 0;
  const latest = await agentApi.fetchHistoryPage(threadId, canvasId, limit);
  let turns = latest.turns;
  let before = latest.before;
  let hasMore = latest.hasMore;
  let overlapsCache = turns.some((turn) => cachedTurnIds.has(turn.id));

  while (hadCachedHistory && !overlapsCache && hasMore && before) {
    const older = await agentApi.fetchHistoryPage(
      threadId,
      canvasId,
      limit,
      before,
    );
    turns = [...older.turns, ...turns];
    before = older.before;
    hasMore = older.hasMore;
    overlapsCache = older.turns.some((turn) => cachedTurnIds.has(turn.id));
  }

  return {
    response: { ...latest, turns, before, hasMore },
    hadCachedHistory,
    overlapsCache,
  };
}

function applyLatestHistoryWindow(window: LatestHistoryWindow): void {
  if (window.hadCachedHistory && window.overlapsCache) {
    const state = useChatStore.getState();
    state.mergeLatestHistoryMessages(
      window.response.threadId,
      historyTurnsToMessages(window.response.turns),
    );
    state.setHistoryLoaded(window.response.threadId, true);
    return;
  }
  applyInitialHistoryPage(window.response);
}

export interface ChatHistoryWindow {
  loadOlderHistory: () => void;
  retryHistory: () => void;
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
  const isHistoryLoaded = useChatStore((state) =>
    selectThreadHistoryLoaded(state, threadId),
  );
  const addMessage = useChatStore((state) => state.addMessage);
  const historyError = useChatStore(
    (state) => state.threadsById[threadId]?.historyError ?? null,
  );
  const recentTurnCount = useChatPreferencesStore(
    (state) => state.recentTurnCount,
  );
  const effectiveConversationView = session.conversationView;
  const ownerCanvasId =
    effectiveConversationView?.conversationOwner.canvasId || canvasId;
  const ownerNodeId =
    effectiveConversationView?.conversationOwner.nodeId ?? null;
  const ownerSource = useConversationOwnerSource(effectiveConversationView);
  const ownerStatus = ownerSource?.status;
  const ownerInvocationToken = ownerSource?.invocationToken;
  const ownerHistoryKey = effectiveConversationView
    ? JSON.stringify([
        ownerCanvasId,
        threadId,
        ownerInvocationToken ?? null,
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
      return fetchLatestHistoryWindow(tid, ownerCanvasId, recentTurnCount);
    };

    fetchValidatedHistory()
      .then((window) => {
        if (cancelled || !window) return;
        const res = window.response;

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

        applyLatestHistoryWindow({
          ...window,
          response: { ...res, threadId: finalTid },
        });
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
    recentTurnCount,
    historyError,
    isHistoryLoaded,
    isStreaming,
    needsOwnerRefresh,
    ownerHistoryKey,
  ]);

  const loadOlderHistory = useCallback(() => {
    if (!ownerCanvasId) return;
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
        recentTurnCount,
        requestedBefore,
      )
      .then((response) => {
        const current = selectThreadHistoryPageState(
          useChatStore.getState(),
          threadId,
        );
        if (current.historyBefore !== requestedBefore) return;
        const state = useChatStore.getState();
        state.prependHistoryMessages(
          threadId,
          historyTurnsToMessages(response.turns),
        );
        state.setHistoryPageState(threadId, {
          before: response.before ?? null,
          hasOlder: response.hasMore,
          loadingOlder: false,
          error: null,
        });
      })
      .catch(async (error: unknown) => {
        const current = selectThreadHistoryPageState(
          useChatStore.getState(),
          threadId,
        );
        if (current.historyBefore !== requestedBefore) return;
        if (error instanceof ApiError && error.status === 409) {
          try {
            const response = await agentApi.fetchHistoryPage(
              threadId,
              ownerCanvasId,
              recentTurnCount,
            );
            applyInitialHistoryPage(response);
            return;
          } catch (refreshError: unknown) {
            error = refreshError;
          }
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
  }, [ownerCanvasId, recentTurnCount, threadId]);

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
        recentTurnCount,
      );
      if (cancelled) return;
      applyLatestHistoryWindow(refreshed);

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
          recentTurnCount,
        );
        if (!cancelled) {
          applyLatestHistoryWindow(finalHistory);
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
        // A disposed observer must not settle a successor's queue.
        if (cancelled) return;
        settleAgentTurnQueue(
          { threadId: ownerThreadId, ownerCanvasId },
          queueCompletedNormally,
        );
      });

    return () => {
      cancelled = true;
      // Only this live attachment owns its loading state; a released claim may
      // already have been replaced by a new send.
      if (!claim.signal.aborted) setIsLoading(ownerThreadId, false);
      claim.release();
    };
  }, [
    isHistoryLoaded,
    threadId,
    ownerCanvasId,
    ownerNodeId,
    ownerStatus,
    ownerInvocationToken,
    effectiveConversationView,
    previewTabId,
    addMessage,
    setIsLoading,
    recentTurnCount,
  ]);

  const retryHistory = useCallback(() => {
    useChatStore.getState().setHistoryError(threadId, null);
  }, [threadId]);

  return {
    loadOlderHistory,
    retryHistory,
    isCurrentOwnerHistory:
      isHistoryLoaded && !historyError && hydratedOwnerKey === ownerHistoryKey,
  };
}
