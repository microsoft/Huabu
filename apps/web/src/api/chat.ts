import { API_CONFIG } from '../config/api';

import type {
  ChatHistoryResponse,
  SendMessageRequest,
  ChatStreamUpdatePayload,
} from '@sediment/shared';

export interface StreamCallbacks {
  onUpdate: (payload: ChatStreamUpdatePayload) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

export const chatApi = {
  fetchHistory: async (threadId: string): Promise<ChatHistoryResponse> => {
    const response = await fetch(
      `${API_CONFIG.API_URL}/chat/history/${encodeURIComponent(threadId)}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to load history: ${response.status}`);
    }
    return (await response.json()) as ChatHistoryResponse;
  },
  streamMessage: async (
    content: string,
    threadId: string,
    selectedSourceIds: string[],
    callbacks: StreamCallbacks,
  ): Promise<void> => {
    try {
      const response = await fetch(`${API_CONFIG.API_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          threadId,
          selectedSourceIds,
        } satisfies SendMessageRequest),
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
        console.log('Stream chunk received:', chunk);
        buffer += chunk;

        // Split by double newline to get events
        const parts = buffer.split('\n\n');
        // Keep the last part in the buffer if it's incomplete
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;

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
          const dataStr = dataLines.join('\n');

          if (eventType === 'update') {
            try {
              const data = JSON.parse(dataStr) as ChatStreamUpdatePayload;
              callbacks.onUpdate(data);
            } catch (e) {
              console.error('Failed to parse update data', e);
            }
          } else if (eventType === 'error') {
            const errPayload = JSON.parse(dataStr);
            callbacks.onError(new Error(errPayload.message));
          } else if (eventType === 'end') {
            console.log('Stream ended via event');
            callbacks.onComplete();
            return;
          }
        }
      }

      // Stream finished without explicit 'end' event
      callbacks.onComplete();
    } catch (error) {
      console.error('Stream error:', error);
      callbacks.onError(
        error instanceof Error ? error : new Error('Unknown stream error'),
      );
    }
  },
};
