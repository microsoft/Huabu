// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';

import { createId } from '@huabu/shared';

import { agentApi } from '@/api/agent';
import { isActivelyViewingQuestion } from '@/hooks/useActivelyViewingQuestion';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadHistoryLoaded,
  selectThreadLastAction,
  selectThreadMessages,
  useChatStore,
} from '@/store/chatStore';
import {
  ConversationIntegrityError,
  filterClientOwnedQuestionPatch,
  patchConversationOwnerNode,
  refreshConversationPresentation,
  resolveConversationOwnerSource,
  validateConversationView,
} from '@/store/conversationOwner';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { claimAgentStream } from './agentStreamCoordinator';
import { handleStreamEvent } from './useAgentStream';

import type { ChatSession } from './useChatSession';
import type { ChatMessage } from '../store/chatTypes';
import type { AgentStreamEvent, ChatHistoryResponse } from '@huabu/shared';

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

function historyResponseToMessages(
  response: ChatHistoryResponse,
): ChatMessage[] {
  return response.messages.flatMap((message, index): ChatMessage[] => {
    const id = `history-${index}`;
    if (!KNOWN_HISTORY_ROLES.has(message.role)) return [];

    if (message.role === 'status') {
      return [
        {
          id,
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
        role: 'user',
        content: message.content || '',
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
): void {
  const { threadId, canvasId } = session;
  const isHistoryLoaded = useChatStore((state) =>
    selectThreadHistoryLoaded(state, threadId),
  );
  const addMessage = useChatStore((state) => state.addMessage);
  const effectiveConversationView = session.conversationView;
  const ownerCanvasId =
    effectiveConversationView?.conversationOwner.canvasId || canvasId;
  const ownerNodeId =
    effectiveConversationView?.conversationOwner.nodeId ?? null;
  const ownerStatus = useCanvasStore((state) => {
    if (!ownerNodeId || state.canvasId !== ownerCanvasId) return undefined;
    const owner = state.nodes.find((node) => node.id === ownerNodeId);
    return (owner?.data as { status?: unknown } | undefined)?.status;
  });

  // Load history from server on first mount (once per thread).
  // Wait for canvasId to be available — on initial mount the canvas may
  // not have loaded yet, causing a request without canvasId that 404s.
  useEffect(() => {
    if (!ownerCanvasId) return;
    // Snapshot the thread we're loading for. If the user switches threads
    // mid-fetch, we still want to land the response on the originating
    // thread (cache survives navigation) rather than the current one.
    const tid = threadId;
    if (selectThreadHistoryLoaded(useChatStore.getState(), tid)) return;

    let cancelled = false;

    const currentState = useChatStore.getState();
    const action = selectThreadLastAction(currentState, tid);
    const { setMessages: set, setHistoryLoaded: setLoaded } = currentState;

    const fetchValidatedHistory = async () => {
      if (effectiveConversationView) {
        try {
          await validateConversationView(effectiveConversationView);
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
      return agentApi.fetchHistory(tid, ownerCanvasId);
    };

    fetchValidatedHistory()
      .then((res) => {
        if (cancelled || !res) return;

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

        const serverMessages = historyResponseToMessages(res);
        set(finalTid, serverMessages);
        setLoaded(finalTid, true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn(`Could not load ${action} history:`, err);
        setLoaded(tid, true);
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
  ]);

  // Try to reconnect to an active server-side run after history is loaded.
  // This handles the page-refresh case: events buffered during the refresh
  // are replayed, then live streaming resumes.
  useEffect(() => {
    if (!isHistoryLoaded || !threadId || !ownerCanvasId) return;

    const msgs = selectThreadMessages(useChatStore.getState(), threadId);
    const historyLooksIncomplete =
      msgs.length > 0 && msgs[msgs.length - 1]?.role === 'user';
    if (ownerStatus !== 'running' && !historyLooksIncomplete) return;

    let cancelled = false;
    const ownerThreadId = threadId;
    const ownerView = effectiveConversationView;
    const claim = claimAgentStream(ownerCanvasId, ownerThreadId, 'attach');
    if (!claim) return;

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

      const refreshed = await agentApi.fetchHistory(
        ownerThreadId,
        ownerCanvasId,
      );
      if (cancelled) return;
      useChatStore
        .getState()
        .setMessages(ownerThreadId, historyResponseToMessages(refreshed));
      useChatStore.getState().setHistoryLoaded(ownerThreadId, true);

      const assistantId = createId('message');
      // Flag set to true once we know the server has an active run
      let streaming = false;
      // Track whether a usable final `done` event arrived so a late
      // cap-out error after a complete answer terminalizes as `done`.
      let sawDone = false;

      // Drive the question node that owns the reconnected thread to a
      // terminal status. Resolves the node by `data.threadId` so it
      // works regardless of which thread is currently visible. Only
      // rescues a still-live node (`running` / `pending`): never
      // overrides a terminal status the originating run already wrote,
      // nor resurrects a user cancel (`idle`).
      const rescueQuestionNode = (
        forThreadId: string,
        patch: Record<string, unknown>,
      ) => {
        if (
          ownerView?.conversationOwner.threadId === forThreadId &&
          ownerView.conversationOwner.canvasId === ownerCanvasId
        ) {
          const canvas = useCanvasStore.getState();
          const ownerPatch = filterClientOwnedQuestionPatch(
            resolveConversationOwnerSource(
              canvas.canvasId,
              canvas.nodes,
              canvas.worldReferences,
              ownerView,
            ),
            patch,
          );
          if (!ownerPatch) return;
          void patchConversationOwnerNode(ownerView, ownerPatch)
            .then(async () => {
              await refreshConversationPresentation(ownerView);
              if (
                ownerView.presentationAnchor.canvasId !==
                  ownerView.conversationOwner.canvasId ||
                ownerView.presentationAnchor.nodeId !==
                  ownerView.conversationOwner.nodeId
              ) {
                await useAcpThreadChangesStore
                  .getState()
                  .load(ownerCanvasId, forThreadId);
              }
            })
            .catch((error) =>
              console.error(
                '[useChatHistory] failed to persist owner lifecycle',
                error,
              ),
            );
          return;
        }
        const node = useCanvasStore
          .getState()
          .nodes.find(
            (n) =>
              n.type === 'question' &&
              (n.data as Record<string, unknown> | undefined)?.threadId ===
                forThreadId,
          );
        if (!node) return;
        const bindingPolicy = (
          node.data as { agentBindingPolicy?: unknown } | undefined
        )?.agentBindingPolicy;
        const ownerPatch = filterClientOwnedQuestionPatch(
          bindingPolicy === 'fixed' || bindingPolicy === 'selectable'
            ? { agentBindingPolicy: bindingPolicy }
            : undefined,
          patch,
        );
        if (!ownerPatch) return;
        const curStatus = (node.data as Record<string, unknown> | undefined)
          ?.status;
        if (
          bindingPolicy !== 'fixed' &&
          curStatus !== 'running' &&
          curStatus !== 'pending'
        ) {
          return;
        }
        useCanvasStore.getState().patchNodeSilent(node.id, ownerPatch);
      };

      // Clear assistant / status messages loaded from history for the
      // current run — the reconnect event buffer replays them fully.
      // Keep only messages up to and including the last user message.
      const clearStaleMessages = () => {
        const current = selectThreadMessages(
          useChatStore.getState(),
          ownerThreadId,
        );
        let lastUserIdx = -1;
        for (let i = current.length - 1; i >= 0; i--) {
          if (current[i].role === 'user') {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx >= 0) {
          useChatStore
            .getState()
            .setMessages(ownerThreadId, current.slice(0, lastUserIdx + 1));
        }
      };

      const result = await agentApi.reconnectStream(
        ownerThreadId,
        ownerCanvasId,
        {
          onEvent: (event: AgentStreamEvent) => {
            if (cancelled) return;
            if (event.type === 'done') sawDone = true;
            if (!streaming) {
              streaming = true;
              setIsLoading(ownerThreadId, true);
              clearStaleMessages();
            }
            handleStreamEvent(event, { threadId: ownerThreadId, assistantId });
          },
          onError: (err) => {
            if (cancelled) return;
            addMessage(ownerThreadId, {
              id: createId('status'),
              role: 'status',
              status: 'error',
              detail: err.message,
            });
            setIsLoading(ownerThreadId, false);
            // A reconnected run that errors must still terminalize the
            // owning question node — otherwise it stalls at `running`.
            rescueQuestionNode(
              ownerThreadId,
              sawDone
                ? { status: 'done', errorMessage: undefined }
                : { status: 'error', errorMessage: err.message },
            );
          },
          onComplete: () => {
            if (cancelled) return;
            setIsLoading(ownerThreadId, false);
            // When the reconnect stream is the consumer that sees the run
            // finish, the originating `useQuestionRunner` callback may
            // never fire (its POST stream was superseded / dropped). Drive
            // the question node to `done` here so the status badge + chat
            // affordance reappear. Count it as viewed only if the user is
            // actively watching — this thread is open AND the chat panel is
            // expanded; a collapsed panel leaves the answer unread.
            const stillViewing = isActivelyViewingQuestion({
              threadId: ownerThreadId,
            });
            rescueQuestionNode(ownerThreadId, {
              status: 'done',
              errorMessage: undefined,
              ...(stillViewing ? { viewed: true } : {}),
            });
          },
        },
        claim.signal,
      );

      if (result.status === 'inactive' && !cancelled) {
        const finalHistory = await agentApi.fetchHistory(
          ownerThreadId,
          ownerCanvasId,
        );
        if (!cancelled) {
          useChatStore
            .getState()
            .setMessages(
              ownerThreadId,
              historyResponseToMessages(finalHistory),
            );
          useChatStore.getState().setHistoryLoaded(ownerThreadId, true);
          setIsLoading(ownerThreadId, false);
        }
      }
      if (result.status !== 'aborted') {
        attachRetryDelayByThread.delete(ownerThreadId);
      }
    };

    void tryReconnect()
      .catch(async (error) => {
        if (cancelled || claim.signal.aborted) return;
        console.error('[useChatHistory] reconnect failed', error);
        const current = useCanvasStore.getState();
        const ownerStillRunning =
          !!ownerNodeId &&
          current.canvasId === ownerCanvasId &&
          (
            current.nodes.find((node) => node.id === ownerNodeId)?.data as
              | { status?: unknown }
              | undefined
          )?.status === 'running';
        if (ownerStillRunning || historyLooksIncomplete) {
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
      .finally(() => claim.release());

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
}
