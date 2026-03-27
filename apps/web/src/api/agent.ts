/**
 * Unified Agent API Client
 *
 * Communicates with the new unified /api/agent endpoint that handles
 * all modes (chat, agent) with pi-ai streaming.
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
  fetchHistory: async (
    threadId: string,
    canvasId?: string,
  ): Promise<ChatHistoryResponse> => {
    const params = canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : '';
    const response = await fetch(
      `${API_CONFIG.API_URL}/agent/history/${encodeURIComponent(threadId)}${params}`,
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
   * Explicitly stop an active agent run on the server.
   */
  stopThread: async (threadId: string): Promise<void> => {
    await fetch(
      `${API_CONFIG.API_URL}/agent/stop/${encodeURIComponent(threadId)}`,
      { method: 'POST' },
    );
  },

  /**
   * Reconnect to an active agent run after page refresh.
   * Returns false if no active run exists (404), otherwise streams events.
   */
  reconnectStream: async (
    threadId: string,
    callbacks: AgentStreamCallbacks,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    try {
      const response = await fetch(
        `${API_CONFIG.API_URL}/agent/stream/${encodeURIComponent(threadId)}`,
        { signal },
      );

      if (response.status === 404) return false;
      if (!response.ok || !response.body) return false;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const parsed = parseSSEChunk(part);
          if (!parsed) continue;

          const { eventType, data } = parsed;
          try {
            const eventData = JSON.parse(data) as Record<string, unknown>;
            if (eventType === 'end') {
              callbacks.onComplete();
              return true;
            } else if (eventType === 'error') {
              callbacks.onError(
                new Error((eventData.error as string) ?? 'Unknown error'),
              );
              return true;
            } else if (eventType !== 'meta') {
              callbacks.onEvent({
                type: eventType as AgentStreamEvent['type'],
                data: eventData,
              });
            }
          } catch (e) {
            console.error(`[agent] Failed to parse reconnect ${eventType}:`, e);
          }
        }
      }

      callbacks.onComplete();
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Send a message and stream the response via SSE.
   * Pass an AbortSignal to allow cancellation of the stream.
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
      selectedNodeIds?: string[];
      signal?: AbortSignal;
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
      selectedNodeIds: options?.selectedNodeIds?.length
        ? options.selectedNodeIds
        : undefined,
    };

    try {
      const response = await fetch(`${API_CONFIG.API_URL}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options?.signal,
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
      // Treat any error while the signal is aborted as an intentional stop
      if (options?.signal?.aborted) {
        callbacks.onComplete();
        return;
      }
      console.error('[agent] Stream error:', error);
      callbacks.onError(
        error instanceof Error ? error : new Error('Unknown stream error'),
      );
    }
  },

  /**
   * Fetch the current context token count for a conversation thread.
   */
  fetchContextTokens: async (
    threadId: string,
    canvasId?: string,
    signal?: AbortSignal,
  ): Promise<{ contextTokens: number; contextWindow: number }> => {
    const params = canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : '';
    const response = await fetch(
      `${API_CONFIG.API_URL}/agent/context-tokens/${encodeURIComponent(threadId)}${params}`,
      { signal },
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json() as Promise<{
      contextTokens: number;
      contextWindow: number;
    }>;
  },
};
