/**
 * Chat API — wraps the unified agent API with chat-specific interface.
 *
 * Now routes through /api/agent with mode='chat' instead of the old /api/chat.
 * Provides backward compatibility for existing chat components.
 */

import { agentApi } from './unified-agent';

import type {
  AgentBaseContext,
  AgentStreamEvent,
  ChatAttachment,
  ChatHistoryResponse,
  ChatStreamUpdatePayload,
  ToolResponse,
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
 * Parse a tool result string into a proper ToolResponse object.
 */
function parseToolResult(
  toolName: string,
  raw: string | undefined,
): ToolResponse<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Already a ToolResponse shape?
    if (
      parsed &&
      typeof parsed === 'object' &&
      'tool' in parsed &&
      'status' in parsed
    ) {
      return parsed as ToolResponse<string, unknown>;
    }
    // Wrap raw result
    return { tool: toolName, status: 'success', data: parsed };
  } catch {
    return { tool: toolName, status: 'success', data: { content: raw } };
  }
}

/**
 * Chat API
 */
export const chatApi = {
  /**
   * Fetch chat history for a thread.
   * Returns ChatHistoryResponse format (backward compatible).
   */
  fetchHistory: async (threadId: string): Promise<ChatHistoryResponse> => {
    return agentApi.fetchHistory(threadId) as Promise<ChatHistoryResponse>;
  },

  /**
   * Send a message and stream the response
   */
  streamMessage: async (
    content: string,
    threadId: string,
    canvasContext: AgentBaseContext | undefined,
    callbacks: StreamCallbacks,
    attachments?: ChatAttachment[],
  ): Promise<void> => {
    return agentApi.streamMessage(
      content,
      threadId,
      'chat',
      {
        onEvent: (event: AgentStreamEvent) => {
          if (event.type === 'meta') {
            callbacks.onUpdate({
              node: 'meta',
              metadata: event.data as Record<string, unknown>,
            });
          } else if (event.type === 'text_delta') {
            callbacks.onUpdate({
              node: 'agent',
              message: {
                role: 'assistant',
                content: event.data.content ?? '',
              },
            });
          } else if (event.type === 'tool_result') {
            const toolResponse = parseToolResult(
              event.data.toolName ?? 'unknown',
              event.data.toolResult,
            );
            if (toolResponse) {
              callbacks.onUpdate({
                node: 'tools',
                toolResponse,
              });
            }
          }
          // tool_start, thinking_delta, done — don't emit as chat updates
        },
        onError: callbacks.onError,
        onComplete: callbacks.onComplete,
      },
      {
        canvasContext,
        attachments,
      },
    );
  },
};
