import { useEffect } from 'react';

import { createId } from '@sediment/shared';

import { agentApi } from '@/api/agent';
import { isActivelyViewingQuestion } from '@/hooks/useActivelyViewingQuestion';
import { useAcpThreadChangesStore } from '@/store/acpThreadChangesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import {
  ConversationIntegrityError,
  patchConversationOwnerNode,
  refreshConversationPresentation,
  validateConversationView,
} from '@/store/conversationOwner';

import { handleStreamEvent } from './useAgentStream';

import type { ChatMessage } from '../store/chatTypes';
import type { AgentStreamEvent } from '@sediment/shared';

/**
 * Hook that loads chat history from the server and handles reconnection
 * to an active agent run after page refresh.
 *
 * @param setIsLoading - Setter from useAgentStream to reflect reconnect
 *   loading state. Takes an explicit `threadId` so reconnects on a
 *   backgrounded thread don't flip loading on the visible one.
 */
export function useChatHistory(
  setIsLoading: (threadId: string, loading: boolean) => void,
): void {
  const threadId = useChatStore((state) => state.threadId);
  const isHistoryLoaded = useChatStore((state) =>
    state.historyLoadedThreads.has(state.threadId),
  );
  const addMessage = useChatStore((state) => state.addMessage);
  const canvasId = useCanvasStore((state) => state.canvasId);
  const conversationView = useChatStore((state) => state.viewingQuestionThread);
  const savedReplay = useChatStore((state) =>
    canvasId ? state.questionReplayByCanvas[canvasId]?.view : undefined,
  );
  const effectiveConversationView =
    conversationView?.presentationAnchor.canvasId === canvasId
      ? conversationView
      : (savedReplay ?? null);
  const ownerCanvasId =
    effectiveConversationView?.conversationOwner.canvasId || canvasId;

  // Switch chat thread when canvas changes
  useEffect(() => {
    if (canvasId) {
      useChatStore.getState().switchToCanvas(canvasId);
    }
  }, [canvasId]);

  // Load history from server on first mount (once per thread).
  // Wait for canvasId to be available — on initial mount the canvas may
  // not have loaded yet, causing a request without canvasId that 404s.
  useEffect(() => {
    if (!ownerCanvasId) return;
    // Snapshot the thread we're loading for. If the user switches threads
    // mid-fetch, we still want to land the response on the originating
    // thread (cache survives navigation) rather than the current one.
    const tid = useChatStore.getState().threadId;
    if (useChatStore.getState().historyLoadedThreads.has(tid)) return;

    let cancelled = false;

    const {
      lastAction: action,
      setMessages: set,
      setHistoryLoaded: setLoaded,
    } = useChatStore.getState();

    const fetchValidatedHistory = async () => {
      if (effectiveConversationView) {
        try {
          await validateConversationView(effectiveConversationView);
        } catch (error) {
          if (error instanceof ConversationIntegrityError) {
            const current = useChatStore.getState().viewingQuestionThread;
            if (
              current?.presentationAnchor.canvasId ===
                effectiveConversationView.presentationAnchor.canvasId &&
              current.presentationAnchor.nodeId ===
                effectiveConversationView.presentationAnchor.nodeId
            ) {
              useChatStore
                .getState()
                .closeQuestionThread(
                  effectiveConversationView.presentationAnchor.canvasId,
                );
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
        if (overrideTid) {
          const current = useChatStore.getState();
          const currentOwnerCanvasId =
            current.viewingQuestionThread?.conversationOwner.canvasId ||
            useCanvasStore.getState().canvasId;
          if (
            current.threadId === tid &&
            currentOwnerCanvasId === ownerCanvasId
          ) {
            useChatStore.setState((state) => ({
              threadId: overrideTid,
              threadMap: {
                ...state.threadMap,
                [ownerCanvasId]: overrideTid,
              },
            }));
          }
        }

        const serverMessages: ChatMessage[] = res.messages.map(
          (m, i): ChatMessage => {
            const id = `history-${i}`;

            if (m.role === 'status') {
              return {
                id,
                role: 'status' as const,
                status: m.status,
                detail: m.detail,
              };
            }

            if (m.role === 'intent-select') {
              return {
                id,
                role: 'intent-select' as const,
                candidates: m.candidates,
                selectedIntent: m.selectedIntent,
              };
            }

            if (m.role === 'assistant') {
              // Wire shape mirrors the runtime AssistantSegment union
              // (see chatTypes.ts) — the server already produces the
              // correct text/thinking/tool/plan/status part order; we
              // pass it through unchanged so live streaming and
              // rehydration share one renderer dispatch.
              const attachmentsField =
                m.attachments && m.attachments.length > 0
                  ? { attachments: m.attachments }
                  : {};
              const selectedNodesField =
                m.selectedNodeIds && m.selectedNodeIds.length > 0
                  ? { selectedNodeIds: m.selectedNodeIds }
                  : {};
              return {
                id,
                role: 'assistant' as const,
                segments: m.parts,
                ...attachmentsField,
                ...selectedNodesField,
              };
            }

            // role === 'user'
            const attachmentsField =
              m.attachments && m.attachments.length > 0
                ? { attachments: m.attachments }
                : {};
            const selectedNodesField =
              m.selectedNodeIds && m.selectedNodeIds.length > 0
                ? { selectedNodeIds: m.selectedNodeIds }
                : {};
            const selectedStrokesField =
              m.selectedStrokeIds && m.selectedStrokeIds.length > 0
                ? { selectedStrokeIds: m.selectedStrokeIds }
                : {};
            const invokedSkillsField =
              m.invokedSkills && m.invokedSkills.length > 0
                ? { invokedSkills: m.invokedSkills }
                : {};
            return {
              id,
              role: 'user' as const,
              content: m.content || '',
              ...attachmentsField,
              ...selectedNodesField,
              ...selectedStrokesField,
              ...invokedSkillsField,
            };
          },
        );
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
  }, [threadId, ownerCanvasId, effectiveConversationView]);

  // Try to reconnect to an active server-side run after history is loaded.
  // This handles the page-refresh case: events buffered during the refresh
  // are replayed, then live streaming resumes.
  useEffect(() => {
    if (!isHistoryLoaded || !threadId || !ownerCanvasId) return;

    // Only attempt reconnect if history suggests an incomplete run:
    // the last message is from the user (or intent-select) without a
    // following assistant response, meaning the server may still be
    // streaming. If history is empty or ends with an assistant message,
    // there's nothing to reconnect to — skip the request entirely to
    // avoid a 404 in the browser console.
    const msgs = useChatStore.getState().messagesByThread[threadId] ?? [];
    if (msgs.length === 0) return;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg.role !== 'user' && lastMsg.role !== 'intent-select') return;

    // This client already owns a live consumer for the thread — either the
    // POST stream `startStream` opened for the message just sent, or an
    // earlier reconnect that is still pumping. Attaching a second consumer
    // would replay the same in-flight turn under a fresh `assistantId` and
    // render the answer twice. `loadingThreadIds` is never persisted, so a
    // page refresh (the case this reconnect exists for) still passes.
    //
    // The window matters most right after a send: the assistant message
    // does not exist until the first event, so `lastMsg` stays `user` for
    // the whole lead time — seconds on a resumed ACP session, during which
    // any re-render that changes `effectiveConversationView` (e.g.
    // re-opening the same question thread) re-runs this effect.
    if (useChatStore.getState().loadingThreadIds.has(threadId)) return;

    let cancelled = false;
    const ownerThreadId = threadId;
    const ownerView = effectiveConversationView;
    const abortController = new AbortController();

    const tryReconnect = async () => {
      if (ownerView) {
        try {
          await validateConversationView(ownerView);
        } catch (error) {
          if (error instanceof ConversationIntegrityError) {
            const current = useChatStore.getState().viewingQuestionThread;
            if (
              current?.presentationAnchor.canvasId ===
                ownerView.presentationAnchor.canvasId &&
              current.presentationAnchor.nodeId ===
                ownerView.presentationAnchor.nodeId
            ) {
              useChatStore
                .getState()
                .closeQuestionThread(ownerView.presentationAnchor.canvasId);
            }
            return;
          }
          throw error;
        }
      }
      if (cancelled) return;

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
          void patchConversationOwnerNode(ownerView, patch)
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
        const curStatus = (node.data as Record<string, unknown> | undefined)
          ?.status;
        if (curStatus !== 'running' && curStatus !== 'pending') return;
        useCanvasStore.getState().patchNodeSilent(node.id, patch);
      };

      // Clear assistant / status messages loaded from history for the
      // current run — the reconnect event buffer replays them fully.
      // Keep only messages up to and including the last user message.
      const clearStaleMessages = () => {
        const current =
          useChatStore.getState().messagesByThread[ownerThreadId] ?? [];
        let lastUserIdx = -1;
        for (let i = current.length - 1; i >= 0; i--) {
          if (
            current[i].role === 'user' ||
            current[i].role === 'intent-select'
          ) {
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

      const connected = await agentApi.reconnectStream(
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
            clearStaleMessages();
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
        abortController.signal,
      );

      if (connected && !cancelled) {
        // Reconnection was successful — events were processed above
      }
    };

    void tryReconnect();

    return () => {
      cancelled = true;
      // Release the HTTP stream (and the server-side tail behind it) so a
      // superseded attempt doesn't keep draining the run's event log.
      abortController.abort();
    };
  }, [
    isHistoryLoaded,
    threadId,
    ownerCanvasId,
    effectiveConversationView,
    addMessage,
    setIsLoading,
  ]);
}
