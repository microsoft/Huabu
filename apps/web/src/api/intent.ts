/**
 * Intent recognition API client.
 */

import { API_CONFIG } from '../config/api';

import type {
  AgentBaseContext,
  IntentCandidate,
  IntentEpisode,
} from '@sediment/shared';

/**
 * Stream intent recognition via SSE — calls onCandidate for each candidate
 * as it arrives from the LLM token stream.
 */
export async function recognizeIntentStream(
  canvasContext: AgentBaseContext,
  onCandidate: (candidate: IntentCandidate) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/intent/recognize-stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasContext }),
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Intent streaming failed: ${response.status} ${response.statusText}`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from buffer
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    let eventType = '';
    let dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line === '') {
        // Empty line = end of event
        if (eventType && dataLines.length > 0) {
          const data = dataLines.join('\n');
          if (eventType === 'candidate') {
            try {
              const candidate = JSON.parse(data) as IntentCandidate;
              onCandidate(candidate);
            } catch {
              console.warn('[intent] Failed to parse streaming candidate');
            }
          } else if (eventType === 'error') {
            const parsed = JSON.parse(data) as { error?: string };
            throw new Error(parsed.error ?? 'Intent recognition failed');
          }
        }
        eventType = '';
        dataLines = [];
      }
    }
  }
}

/**
 * Log an intent episode (user's choice or dismissal) for preference learning.
 */
export async function logIntentEpisode(
  episode: IntentEpisode,
  canvasId?: string,
): Promise<void> {
  await fetch(`${API_CONFIG.API_URL}/intent/episode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episode, canvasId }),
  }).catch((err) => {
    console.error('[intent] Failed to log episode:', err);
  });
}

/**
 * Stream sketch intent recognition via SSE.
 * Same pattern as `recognizeIntentStream` but uses a sketch-specific prompt
 * and only requires a screenshot.
 */
export async function recognizeSketchIntentStream(
  screenshot: string,
  sketchNodeIds: string[],
  onCandidate: (candidate: IntentCandidate) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/intent/recognize-sketch-stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot, sketchNodeIds }),
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Sketch intent streaming failed: ${response.status} ${response.statusText}`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    let eventType = '';
    let dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line === '') {
        if (eventType && dataLines.length > 0) {
          const data = dataLines.join('\n');
          if (eventType === 'candidate') {
            try {
              const candidate = JSON.parse(data) as IntentCandidate;
              onCandidate(candidate);
            } catch {
              console.warn(
                '[intent] Failed to parse sketch streaming candidate',
              );
            }
          } else if (eventType === 'error') {
            const parsed = JSON.parse(data) as { error?: string };
            throw new Error(parsed.error ?? 'Sketch intent recognition failed');
          }
        }
        eventType = '';
        dataLines = [];
      }
    }
  }
}
