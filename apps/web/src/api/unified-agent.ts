/**
 * Unified Agent API Client
 *
 * Communicates with the new unified /api/agent endpoint that handles
 * all modes (chat, research, agent) with pi-ai streaming.
 */

import { API_CONFIG } from '../config/api';

import type {
  AgentMode,
  AgentRequest,
  AgentStreamEvent,
  AgentBaseContext,
  ChatAttachment,
  ChatHistoryResponse,
} from '@sediment/shared';

// ==================== SSE Parser ====================

function parseSSEChunk(
  part: string,
): { eventType: string; data: string } | null {
  if (!part.trim()) return null;

  const lines = part.split('\n');
  let eventType = '';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.substring(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.substring(6).trim());
    }
  }

  const data = dataLines.join('\n');
  if (!eventType || !data) return null;

  return { eventType, data };
}

// ==================== Stream Callbacks ====================

export interface AgentStreamCallbacks {
  /** Called for each streaming event */
  onEvent: (event: AgentStreamEvent) => void;
  /** Called on error */
  onError: (error: Error) => void;
  /** Called when stream completes */
  onComplete: () => void;
}

// ==================== API ====================

export const agentApi = {
  /**
   * Fetch conversation history for a thread.
   */
  fetchHistory: async (threadId: string): Promise<ChatHistoryResponse> => {
    const response = await fetch(
      `${API_CONFIG.API_URL}/agent/history/${encodeURIComponent(threadId)}`,
    );

    if (response.status === 404) {
      throw new Error('Thread not found');
    }

    if (!response.ok) {
      throw new Error(`Failed to load history: ${response.status}`);
    }

    return response.json() as Promise<ChatHistoryResponse>;
  },

  /**
   * Send a message and stream the response via SSE.
   */
  streamMessage: async (
    content: string,
    threadId: string,
    mode: AgentMode,
    callbacks: AgentStreamCallbacks,
    options?: {
      canvasContext?: AgentBaseContext;
      canvasId?: string;
      attachments?: ChatAttachment[];
    },
  ): Promise<void> => {
    const body: AgentRequest = {
      content,
      threadId,
      mode,
      canvasContext: options?.canvasContext,
      canvasId: options?.canvasId,
      attachments: options?.attachments?.length
        ? options.attachments
        : undefined,
    };

    try {
      const response = await fetch(`${API_CONFIG.API_URL}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const parsed = parseSSEChunk(part);
          if (!parsed) continue;

          const { eventType, data } = parsed;

          try {
            const eventData = JSON.parse(data) as Record<string, unknown>;
            const event: AgentStreamEvent = {
              type: eventType as AgentStreamEvent['type'],
              data: eventData,
            };

            if (eventType === 'end') {
              callbacks.onComplete();
              return;
            } else if (eventType === 'error') {
              const errorMsg =
                (eventData.error as string) ?? 'Unknown server error';
              callbacks.onError(new Error(errorMsg));
              return;
            } else {
              callbacks.onEvent(event);
            }
          } catch (e) {
            console.error(`[agent] Failed to parse ${eventType} event:`, e);
          }
        }
      }

      callbacks.onComplete();
    } catch (error) {
      console.error('[agent] Stream error:', error);
      callbacks.onError(
        error instanceof Error ? error : new Error('Unknown stream error'),
      );
    }
  },
};
