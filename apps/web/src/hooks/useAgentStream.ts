// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback } from 'react';

import { createId } from '@huabu/shared';

import { toast } from '@/components/Common/Toast';
import {
  selectThreadIsLoading,
  selectThreadPendingAttachments,
  selectThreadDraft,
  selectThreadMessages,
  selectThreadQuotedComments,
  selectThreadQueuedTurns,
  selectThreadExcludeCanvasSelection,
  useChatStore,
} from '@/store/chatStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { hasAgentStreamClaim } from './agentStreamCoordinator';
import {
  captureAgentTurnSources,
  createAgentTurnUserMessage,
  dispatchAgentTurn,
  prepareAgentTurn,
  prepareAgentTurnRetry,
  resumeAgentTurnQueue,
  stopAgentTurn,
} from './agentTurnController';

import type { ChatSession } from './useChatSession';
import type { ChatMessage } from '@/store/chatTypes';
import type { AgentMode } from '@huabu/shared';

export {
  handleStreamEvent,
  registerAcpSessionMetaSink,
} from './agentTurnController';
export type { AcpSessionMetaStreamEvent } from './agentTurnController';

export interface UseAgentStreamReturn {
  isLoading: boolean;
  setIsLoading: (threadId: string, loading: boolean) => void;
  startStream: (
    prompt: string,
    mode: AgentMode,
    invokedSkills?: string[],
  ) => Promise<void>;
  retryStream: (
    message: Extract<ChatMessage, { role: 'user' }>,
    mode: AgentMode,
  ) => Promise<void>;
  stopStream: () => void;
}

export function useAgentStream(
  session: ChatSession,
  previewTabId?: string,
): UseAgentStreamReturn {
  const isLoading = useChatStore((state) =>
    selectThreadIsLoading(state, session.threadId),
  );
  const setIsLoading = useChatStore((state) => state.setThreadLoading);
  const canDispatch = useCallback(() => {
    if (!previewTabId) return true;
    const target =
      usePreviewWorkspaceStore.getState().workspace.tabs[previewTabId]?.target;
    const view = session.conversationView;
    if (target?.kind === 'conversation' && view) {
      return (
        target.canvasId === session.ownerCanvasId &&
        target.nodeId === view.conversationOwner.nodeId &&
        target.threadId === session.threadId
      );
    }
    return view
      ? target?.kind === 'node' &&
          target.canvasId === view.presentationAnchor.canvasId &&
          target.nodeId === view.presentationAnchor.nodeId
      : target?.kind === 'chat' &&
          target.canvasId === session.canvasId &&
          target.threadId === session.threadId;
  }, [previewTabId, session]);
  const startStream = useCallback(
    async (prompt: string, mode: AgentMode, invokedSkills?: string[]) => {
      const chat = useChatStore.getState();
      const quotedComments = selectThreadQuotedComments(chat, session.threadId);
      if (!prompt.trim() && !quotedComments.length) return;
      if (quotedComments.some((item) => !item.comment.trim())) return;
      const queuedTurns = selectThreadQueuedTurns(chat, session.threadId);
      const shouldQueue =
        selectThreadIsLoading(chat, session.threadId) ||
        queuedTurns.length > 0 ||
        hasAgentStreamClaim(session.ownerCanvasId, session.threadId);
      const draft = selectThreadDraft(chat, session.threadId);
      const excludeCanvasSelection = selectThreadExcludeCanvasSelection(
        chat,
        session.threadId,
      );
      const pending = selectThreadPendingAttachments(chat, session.threadId);
      const excerpt =
        session.canvasId === session.ownerCanvasId
          ? chat.selectionAttachment
          : null;
      const previousMessageId = selectThreadMessages(chat, session.threadId).at(
        -1,
      )?.id;
      let restoreDraft: (() => void) | undefined;
      try {
        const prepared = prepareAgentTurn({
          session,
          inputKind: 'text',
          content: prompt,
          mode,
          invokedSkills,
          quotedComments: quotedComments.length
            ? quotedComments.map(
                ({ quote, contextBefore, contextAfter, comment, source }) => ({
                  quote,
                  contextBefore,
                  contextAfter,
                  comment,
                  ...(source ? { source } : {}),
                }),
              )
            : undefined,
          sources: captureAgentTurnSources(
            session,
            excludeCanvasSelection
              ? { nodeIds: [], strokeSelection: {} }
              : undefined,
          ),
          attachments: [...pending, ...(excerpt ? [excerpt] : [])],
        });
        if (shouldQueue) {
          chat.enqueueTurn(session.threadId, {
            id: createId('queued-turn'),
            prepared,
            status: 'pending',
          });
          chat.consumeDraft(session.threadId, draft, quotedComments);
          chat.setExcludeCanvasSelection(session.threadId, false);
          chat.clearPendingAttachments(session.threadId);
          if (excerpt) chat.setSelectionAttachment(null);
          return;
        }
        chat.setQueuePaused(session.threadId, false);
        let draftConsumed = true;
        let started = false;
        restoreDraft = () => {
          if (!draftConsumed) return;
          draftConsumed = false;
          const current = useChatStore.getState();
          const restored = current.restoreDraftIfEmpty(
            session.threadId,
            draft,
            quotedComments,
          );
          if (restored && excludeCanvasSelection)
            current.setExcludeCanvasSelection(session.threadId, true);
          if (restored) {
            for (const attachment of prepared.attachments ?? [])
              current.addPendingAttachment(session.threadId, attachment);
          }
          if (!restored && !started) {
            const messages = selectThreadMessages(current, session.threadId);
            const lastMessage = messages.at(-1);
            const hasRejection =
              lastMessage?.role === 'status' &&
              lastMessage.id !== previousMessageId;
            // A terminal status prevents reconnect from treating this local snapshot as an active turn.
            current.setMessages(session.threadId, [
              ...(hasRejection ? messages.slice(0, -1) : messages),
              createAgentTurnUserMessage(prepared),
              hasRejection
                ? lastMessage
                : {
                    id: createId('status'),
                    role: 'status',
                    status: 'interrupted',
                  },
            ]);
          }
        };
        chat.consumeDraft(session.threadId, draft, quotedComments);
        chat.setExcludeCanvasSelection(session.threadId, false);
        chat.clearPendingAttachments(session.threadId);
        if (excerpt) chat.setSelectionAttachment(null);
        const result = await dispatchAgentTurn(prepared, {
          canDispatch,
          onStarted: () => {
            started = true;
          },
          onAccepted: () => {
            draftConsumed = false;
          },
          onAcceptanceRejected: restoreDraft,
        });
        if (
          !result.accepted &&
          (result.status === 'rejected' ||
            result.status === 'busy' ||
            result.status === 'stopped')
        )
          restoreDraft();
      } catch (error) {
        restoreDraft?.();
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      }
    },
    [canDispatch, session],
  );
  const retryStream = useCallback(
    async (
      message: Extract<ChatMessage, { role: 'user' }>,
      mode: AgentMode,
    ) => {
      try {
        if (
          message.queuedTurnId &&
          selectThreadQueuedTurns(
            useChatStore.getState(),
            session.threadId,
          ).some((turn) => turn.id === message.queuedTurnId)
        ) {
          resumeAgentTurnQueue(session);
          return;
        }
        await dispatchAgentTurn(prepareAgentTurnRetry(session, message, mode), {
          canDispatch,
        });
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      }
    },
    [canDispatch, session],
  );
  const stopStream = useCallback(() => stopAgentTurn(session), [session]);
  return { isLoading, setIsLoading, startStream, retryStream, stopStream };
}
