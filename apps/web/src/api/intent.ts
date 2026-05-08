/**
 * Intent recognition API client.
 */

import { apiFetch, apiFetchVoid, apiUrl } from './_client';
import { routes } from './_routes';
import { readSSEStream } from './_sse';

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
  // SSE endpoints can't go through `apiFetch` because we need the streaming
  // body — call `fetch` directly but reuse the URL builder + error envelope.
  const response = await fetch(apiUrl(routes.intentRecognizeStream), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvasContext }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Intent streaming failed: ${response.status} ${response.statusText}`,
    );
  }

  await readSSEStream<IntentCandidate | { error?: string }>(
    response,
    (event) => {
      if (event.type === 'candidate') {
        onCandidate(event.data as IntentCandidate);
      } else if (event.type === 'error') {
        const data = event.data as { error?: string };
        throw new Error(data.error ?? 'Intent recognition failed');
      }
    },
    signal,
  );
}

/**
 * Log an intent episode (user's choice or dismissal) for preference learning.
 */
export async function logIntentEpisode(
  episode: IntentEpisode,
  canvasId?: string,
): Promise<void> {
  await apiFetchVoid(routes.intentEpisode, {
    method: 'POST',
    json: { episode, canvasId },
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
  clusterContext: AnnotationClusterContext,
  signal?: AbortSignal,
  canvasId?: string,
): Promise<AnnotationCommandResponse> {
  return apiFetch<AnnotationCommandResponse>(routes.intentRecognizeAnnotation, {
    method: 'POST',
    json: { screenshot, clusterContext, canvasId },
    signal,
    fallbackMessage: 'Annotation command recognition failed',
  });
}
