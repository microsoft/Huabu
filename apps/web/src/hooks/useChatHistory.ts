import { useEffect } from 'react';

import { createId } from '@sediment/shared';

import { agentApi } from '@/api/agent';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';

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
    if (!canvasId) return;
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

    agentApi
      .fetchHistory(tid, canvasId)
      .then((res) => {
        if (cancelled) return;

        // If the server returned a different threadId (fallback to latest),
        // update the client's threadMap so future requests use the correct id.
        const overrideTid =
          res.threadId && res.threadId !== tid ? res.threadId : null;
        const finalTid = overrideTid ?? tid;
        if (overrideTid) {
          useChatStore.setState((state) => ({
            threadId: overrideTid,
            threadMap: { ...state.threadMap, [canvasId]: overrideTid },
          }));
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
  }, [threadId, canvasId]);

  // Try to reconnect to an active server-side run after history is loaded.
  // This handles the page-refresh case: events buffered during the refresh
  // are replayed, then live streaming resumes.
  useEffect(() => {
    if (!isHistoryLoaded || !threadId || !canvasId) return;

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

    let cancelled = false;
    const ownerThreadId = threadId;

    const tryReconnect = async () => {
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
        canvasId,
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
            // affordance reappear. The user has this thread open, so the
            // completion counts as viewed.
            rescueQuestionNode(ownerThreadId, {
              status: 'done',
              errorMessage: undefined,
              viewed: true,
            });
          },
        },
      );

      if (connected && !cancelled) {
        // Reconnection was successful — events were processed above
      }
    };

    void tryReconnect();

    return () => {
      cancelled = true;
    };
    // Only run once after history loads, not on every re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHistoryLoaded, threadId, canvasId]);
}
