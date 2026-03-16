/**
 * Research API — wraps the unified agent API with research-specific interface.
 *
 * Now routes through /api/agent with mode='research' instead of the old /api/research.
 */

import { agentApi } from './unified-agent';

import type {
  AgentBaseContext,
  AgentStreamEvent,
  ChatAttachment,
  ChatHistoryResponse,
  ResearchAgentEvent,
  ResearchConfig,
} from '@sediment/shared';

/**
 * Research-specific stream callbacks
 */
export interface ResearchCallbacks {
  onEvent: (event: ResearchAgentEvent | AgentStreamEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

/**
 * Research API
 */
export const researchApi = {
  /**
   * Fetch research history for a session
   */
  fetchHistory: async (threadId: string): Promise<ChatHistoryResponse> => {
    return agentApi.fetchHistory(threadId);
  },

  /**
   * Start deep research workflow with SSE streaming.
   * Uses the unified agent API with mode='research'.
   */
  startResearch: async (
    query: string,
    canvasId: string,
    _canvasVersion: number,
    threadId: string,
    config: ResearchConfig | undefined,
    callbacks: ResearchCallbacks,
    options?: {
      canvasContext?: AgentBaseContext;
      attachments?: ChatAttachment[];
    },
  ): Promise<void> => {
    const content = config?.searchDepth
      ? `Research this topic (depth: ${config.searchDepth}): ${query}`
      : `Research this topic: ${query}`;

    return agentApi.streamMessage(
      content,
      threadId,
      'research',
      {
        onEvent: (event: AgentStreamEvent) => {
          callbacks.onEvent(event);
        },
        onError: callbacks.onError,
        onComplete: callbacks.onComplete,
      },
      {
        canvasId,
        canvasContext: options?.canvasContext,
        attachments: options?.attachments,
      },
    );
  },
};
