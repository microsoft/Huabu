/**
 * Chat API (Refactored)
 *
 * Type-safe wrapper around AgentAPI for chat operations.
 * Provides backward compatibility with existing components.
 */

import { AgentAPI } from './agent.api';

import type {
  AgentBaseContext,
  ChatHistoryResponse,
  ChatStreamUpdatePayload,
  SendMessageRequest,
} from '@sediment/shared';

/**
 * Chat-specific stream callbacks
 */
export interface StreamCallbacks {
  onUpdate: (payload: ChatStreamUpdatePayload) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

/**
 * Chat API
 */
export const chatApi = {
  /**
   * Fetch chat history for a thread
   */
  fetchHistory: async (threadId: string): Promise<ChatHistoryResponse> => {
    return AgentAPI.getHistory<ChatHistoryResponse>(
      'chat',
      `/chat/history/${encodeURIComponent(threadId)}`,
    ).then((result) => {
      if (!result) {
        throw new Error('Thread not found');
      }
      return result;
    });
  },

  /**
   * Send a message and stream the response
   */
  streamMessage: async (
    content: string,
    threadId: string,
    canvasContext: AgentBaseContext | undefined,
    callbacks: StreamCallbacks,
  ): Promise<void> => {
    const body: SendMessageRequest = {
      content,
      threadId,
      canvasContext,
    };

    // Backend sends ChatStreamUpdatePayload directly in SSE data
    return AgentAPI.stream<ChatStreamUpdatePayload>('chat', '/chat', body, {
      onEvent: (payload) => {
        // Each SSE event with type='update' contains a ChatStreamUpdatePayload
        callbacks.onUpdate(payload);
      },
      onError: callbacks.onError,
      onComplete: callbacks.onComplete,
    });
  },
};
