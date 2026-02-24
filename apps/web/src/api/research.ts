import { API_CONFIG } from '../config/api';

import type { ResearchEvent, ResearchRequest } from '@sediment/shared';

export interface ResearchCallbacks {
  onEvent: (event: ResearchEvent) => void;
  onError: (error: Error) => void;
  onComplete: () => void;
}

export const researchApi = {
  /**
   * Start deep research workflow with SSE streaming
   */
  startResearch: async (
    query: string,
    canvasId: string,
    canvasVersion: number,
    config: ResearchRequest['config'],
    callbacks: ResearchCallbacks,
  ): Promise<void> => {
    try {
      const response = await fetch(`${API_CONFIG.API_URL}/research`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          canvasId,
          canvasVersion,
          config,
        } satisfies ResearchRequest),
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
        console.log('[Research] Stream chunk:', chunk);
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

          // Parse SSE event
          if (eventType === 'thinking') {
            try {
              const data = JSON.parse(dataStr) as ResearchEvent;
              callbacks.onEvent(data);
            } catch (e) {
              console.error('[Research] Failed to parse thinking event', e);
            }
          } else if (eventType === 'searching') {
            try {
              const data = JSON.parse(dataStr) as ResearchEvent;
              callbacks.onEvent(data);
            } catch (e) {
              console.error('[Research] Failed to parse searching event', e);
            }
          } else if (eventType === 'node_created') {
            try {
              const data = JSON.parse(dataStr) as ResearchEvent;
              callbacks.onEvent(data);
            } catch (e) {
              console.error('[Research] Failed to parse node_created event', e);
            }
          } else if (eventType === 'ingesting') {
            try {
              const data = JSON.parse(dataStr) as ResearchEvent;
              callbacks.onEvent(data);
            } catch (e) {
              console.error('[Research] Failed to parse ingesting event', e);
            }
          } else if (eventType === 'synthesis') {
            try {
              const data = JSON.parse(dataStr) as ResearchEvent;
              callbacks.onEvent(data);
            } catch (e) {
              console.error('[Research] Failed to parse synthesis event', e);
            }
          } else if (eventType === 'complete') {
            try {
              const data = JSON.parse(dataStr) as ResearchEvent;
              callbacks.onEvent(data);
              callbacks.onComplete();
              return;
            } catch (e) {
              console.error('[Research] Failed to parse complete event', e);
            }
          } else if (eventType === 'error') {
            try {
              const data = JSON.parse(dataStr) as ResearchEvent;
              callbacks.onEvent(data);
              if (data.type === 'error' && !data.data.recoverable) {
                callbacks.onError(new Error(data.data.message));
                return;
              }
            } catch (e) {
              console.error('[Research] Failed to parse error event', e);
            }
          }
        }
      }

      // Stream finished without explicit 'complete' event
      callbacks.onComplete();
    } catch (error) {
      console.error('[Research] Stream error:', error);
      callbacks.onError(
        error instanceof Error ? error : new Error('Unknown stream error'),
      );
    }
  },
};
