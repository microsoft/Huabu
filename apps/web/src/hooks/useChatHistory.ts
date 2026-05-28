import { createId } from '@sediment/shared';
import { useEffect } from 'react';

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
 * @param setIsLoading - Setter from useAgentStream to reflect reconnect loading state.
 */
export function useChatHistory(setIsLoading: (loading: boolean) => void): void {
  const threadId = useChatStore((state) => state.threadId);
  const isHistoryLoaded = useChatStore((state) => state.isHistoryLoaded);
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
    if (useChatStore.getState().isHistoryLoaded) return;

    let cancelled = false;

    const {
      threadId: tid,
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
        if (res.threadId && res.threadId !== tid) {
          useChatStore.setState((state) => ({
            threadId: res.threadId,
            threadMap: { ...state.threadMap, [canvasId]: res.threadId },
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

            if (m.role === 'prepared-prompt') {
              return {
                id,
                role: 'prepared-prompt' as const,
                prompt: m.prompt,
                agentAlias: m.agentAlias,
                ...(m.error ? { error: m.error } : {}),
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
            return {
              id,
              role: 'user' as const,
              content: m.content || '',
              ...attachmentsField,
              ...selectedNodesField,
            };
          },
        );
        set(serverMessages);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn(`Could not load ${action} history:`, err);
        setLoaded(true);
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
    const msgs = useChatStore.getState().messages;
    if (msgs.length === 0) return;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg.role !== 'user' && lastMsg.role !== 'intent-select') return;

    let cancelled = false;

    const tryReconnect = async () => {
      const assistantId = createId('message');
      const toolQueue = {
        fifo: [] as string[],
      };
      // Flag set to true once we know the server has an active run
      let streaming = false;

      // Clear assistant / status messages loaded from history for the
      // current run — the reconnect event buffer replays them fully.
      // Keep only messages up to and including the last user message.
      const clearStaleMessages = () => {
        const current = useChatStore.getState().messages;
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
            .setMessages(current.slice(0, lastUserIdx + 1));
        }
      };

      const connected = await agentApi.reconnectStream(threadId, {
        onEvent: (event: AgentStreamEvent) => {
          if (cancelled) return;
          if (!streaming) {
            streaming = true;
            setIsLoading(true);
            clearStaleMessages();
          }
          handleStreamEvent(event, { assistantId, toolQueue });
        },
        onError: (err) => {
          if (cancelled) return;
          clearStaleMessages();
          addMessage({
            id: createId('status'),
            role: 'status',
            status: 'error',
            detail: err.message,
          });
          setIsLoading(false);
        },
        onComplete: () => {
          if (cancelled) return;
          setIsLoading(false);
        },
      });

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
