/**
 * Intent recognition API client.
 */

import { API_CONFIG } from '../config/api';

import type {
  AgentBaseContext,
  AnnotationClusterContext,
  AnnotationCommandResponse,
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
 * One-step annotation → canvas commands.
 *
 * Sends a screenshot + structured cluster context to the server. The LLM
 * reasons about the user's intent and returns an executable batch of canvas
 * commands, ready to be applied via `executeCommands`.
 */
export async function recognizeAnnotationCommands(
  screenshot: string,
  annotationNodeIds: string[],
  clusterContext: AnnotationClusterContext,
  signal?: AbortSignal,
): Promise<AnnotationCommandResponse> {
  const response = await fetch(
    `${API_CONFIG.API_URL}/intent/recognize-annotation`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot, annotationNodeIds, clusterContext }),
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Annotation command recognition failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as AnnotationCommandResponse;
}
