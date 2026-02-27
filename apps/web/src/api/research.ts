/**
 * Research API (Refactored)
 *
 * Type-safe wrapper around AgentAPI for research operations.
 * Provides backward compatibility with existing components.
 */

import { AgentAPI } from './agent.api';

import type {
  ChatHistoryResponse,
  ResearchAgentEvent,
  ResearchRequest,
} from '@sediment/shared';

/**
 * Research-specific stream callbacks
 */
export interface ResearchCallbacks {
  onEvent: (event: ResearchAgentEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

/**
 * Research API
 */
export const researchApi = {
  /**
   * Fetch research history for a session
   * Returns same format as chat history (ChatHistoryResponse)
   */
  fetchHistory: async (threadId: string): Promise<ChatHistoryResponse> => {
    return AgentAPI.getHistory<ChatHistoryResponse>(
      'research',
      `/research/history/${encodeURIComponent(threadId)}`,
    ).then((result) => {
      if (!result) {
        throw new Error('Session not found');
      }
      return result;
    });
  },

  /**
   * Start deep research workflow with SSE streaming
   */
  startResearch: async (
    query: string,
    canvasId: string,
    canvasVersion: number,
    threadId: string,
    config: ResearchRequest['config'],
    callbacks: ResearchCallbacks,
  ): Promise<void> => {
    const body: ResearchRequest = {
      query,
      canvasId,
      canvasVersion,
      threadId,
      config,
    };

    // Map generic events to research-specific callbacks
    return AgentAPI.stream<ResearchAgentEvent>('research', '/research', body, {
      onEvent: (event) => {
        console.log('[Research] Event:', event);

        // Pass all events to the generic callback
        callbacks.onEvent(event);

        // Handle terminal events
        if (event.type === 'complete') {
          callbacks.onComplete();
        } else if (event.type === 'error') {
          const message =
            typeof event.data.meta?.message === 'string'
              ? event.data.meta.message
              : 'Research error';
          callbacks.onError(new Error(message));
        }
      },
      onError: callbacks.onError,
      onComplete: callbacks.onComplete,
    });
  },
};
