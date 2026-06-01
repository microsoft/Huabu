/**
 * Intent recognition API client.
 */

import { INTENT_SSE_EVENTS } from '@sediment/shared';

import { apiFetch, apiFetchVoid, apiUrl } from './_client';
import { routes } from './_routes';
import { readTypedSSEStream } from './_sse';

import type {
  SketchClusterContext,
  SketchCommandResponse,
  IntentCandidate,
  IntentContext,
  IntentEpisode,
  IntentStreamEvent,
} from '@sediment/shared';

/**
 * Stream intent recognition via SSE — calls onCandidate for each candidate
 * as it arrives from the LLM token stream.
 */
export async function recognizeIntentStream(
  canvasContext: IntentContext,
  onCandidate: (candidate: IntentCandidate) => void,
  signal?: AbortSignal,
): Promise<void> {
  // SSE endpoints can't go through `apiFetch` because we need the streaming
  // body — call `fetch` directly but reuse the URL builder + error envelope.
  const response = await fetch(apiUrl(routes.intentRecognizeStream), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ canvasContext }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Intent streaming failed: ${response.status} ${response.statusText}`,
    );
  }

  await readTypedSSEStream<IntentStreamEvent>(
    response,
    (event) => {
      if (event.type === INTENT_SSE_EVENTS.Candidate) {
        onCandidate(event.data);
      } else if (event.type === INTENT_SSE_EVENTS.Error) {
        throw new Error(event.data.error || 'Intent recognition failed');
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
 * One-step sketch → canvas commands.
 *
 * Sends a screenshot + structured cluster context to the server. The LLM
 * reasons about the user's intent and returns an executable batch of canvas
 * commands, ready to be applied via `executeCommands`.
 */
export async function recognizeSketchCommands(
  screenshot: string,
  clusterContext: SketchClusterContext,
  signal?: AbortSignal,
  canvasId?: string,
): Promise<SketchCommandResponse> {
  return apiFetch<SketchCommandResponse>(routes.intentRecognizeSketch, {
    method: 'POST',
    json: { screenshot, clusterContext, canvasId },
    signal,
    fallbackMessage: 'Sketch command recognition failed',
  });
}
