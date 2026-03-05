/**
 * Generic Agent API Client
 *
 * Provides unified SSE streaming interface for all agents (chat, research, etc.)
 * This is the low-level API client - specific APIs (chat.ts, research.ts) wrap this
 * with type-safe interfaces.
 */

import { API_CONFIG } from '../config/api';

/**
 * Generic agent event structure
 */
export interface AgentEvent<T = unknown> {
  type: string;
  timestamp: number;
  data: T;
}

/**
 * Stream callbacks
 */
export interface AgentStreamCallbacks<TEvent = AgentEvent> {
  onEvent: (event: TEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

/**
 * SSE Parser - extracts event type and data from SSE chunks
 */
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

/**
 * Generic Agent API
 */
export class AgentAPI {
  /**
   * Stream agent execution via SSE
   *
   * @param agentType - Agent type ('chat' | 'research')
   * @param endpoint - API endpoint path
   * @param body - Request body
   * @param callbacks - Event callbacks
   */
  static async stream<TEvent = AgentEvent>(
    agentType: string,
    endpoint: string,
    body: unknown,
    callbacks: AgentStreamCallbacks<TEvent>,
  ): Promise<void> {
    try {
      const response = await fetch(`${API_CONFIG.API_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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
        console.log(`[${agentType}] Stream chunk:`, chunk);
        buffer += chunk;

        // Split by double newline to get events
        const parts = buffer.split('\n\n');
        // Keep the last part in the buffer if it's incomplete
        buffer = parts.pop() || '';

        for (const part of parts) {
          const parsed = parseSSEChunk(part);
          if (!parsed) continue;

          const { eventType, data } = parsed;

          try {
            const event = JSON.parse(data) as TEvent;

            // Handle special events
            if (eventType === 'end' || eventType === 'complete') {
              callbacks.onEvent(event);
              callbacks.onComplete();
              return;
            } else if (eventType === 'error') {
              // The error SSE payload is {message: string} at the top level
              const errorPayload = event as unknown as {
                message?: string;
                data?: { message?: string; recoverable?: boolean };
              };
              const errorMsg =
                errorPayload.message ??
                errorPayload.data?.message ??
                'Unknown server error';
              callbacks.onError(new Error(errorMsg));
              return;
            } else {
              // Regular event
              callbacks.onEvent(event);
            }
          } catch (e) {
            console.error(
              `[${agentType}] Failed to parse ${eventType} event:`,
              e,
            );
          }
        }
      }

      // Stream finished without explicit 'complete' event
      callbacks.onComplete();
    } catch (error) {
      console.error(`[${agentType}] Stream error:`, error);
      callbacks.onError(
        error instanceof Error ? error : new Error('Unknown stream error'),
      );
    }
  }

  /**
   * Fetch agent history
   *
   * @param agentType - Agent type ('chat' | 'research')
   * @param endpoint - API endpoint path
   * @returns History data or null if not found
   */
  static async getHistory<T>(
    agentType: string,
    endpoint: string,
  ): Promise<T | null> {
    try {
      const response = await fetch(`${API_CONFIG.API_URL}${endpoint}`);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Failed to load history: ${response.status}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      console.error(`[${agentType}] Failed to fetch history:`, error);
      throw error;
    }
  }
}
