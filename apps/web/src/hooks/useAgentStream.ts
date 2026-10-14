// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback } from 'react';

import { toast } from '@/components/Common/Toast';
import {
  selectThreadIsLoading,
  selectThreadPendingAttachments,
  selectThreadDraft,
  selectThreadQuotedComments,
  useChatStore,
} from '@/store/chatStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import {
  captureAgentTurnSources,
  dispatchAgentTurn,
  prepareAgentTurn,
  prepareAgentTurnRetry,
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
      if (
        (!prompt.trim() && !quotedComments.length) ||
        selectThreadIsLoading(chat, session.threadId)
      )
        return;
      const draft = selectThreadDraft(chat, session.threadId);
      const pending = selectThreadPendingAttachments(chat, session.threadId);
      const excerpt = chat.selectionAttachment;
      try {
        const prepared = prepareAgentTurn({
          session,
          inputKind: 'text',
          content: prompt,
          mode,
          invokedSkills,
          quotedComments: quotedComments.length
            ? quotedComments.map(
                ({ quote, contextBefore, contextAfter, comment }) => ({
                  quote,
                  contextBefore,
                  contextAfter,
                  comment,
                }),
              )
            : undefined,
          sources: captureAgentTurnSources(session),
          attachments: [...pending, ...(excerpt ? [excerpt] : [])],
        });
        await dispatchAgentTurn(prepared, {
          canDispatch,
          onAccepted: () => {
            const current = useChatStore.getState();
            current.consumeDraft(session.threadId, draft, quotedComments);
            if (
              selectThreadPendingAttachments(current, session.threadId) ===
              pending
            )
              current.clearPendingAttachments(session.threadId);
            if (current.selectionAttachment === excerpt)
              current.setSelectionAttachment(null);
          },
        });
      } catch (error) {
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
