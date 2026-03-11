/**
 * Intent recognition API client.
 */

import { API_CONFIG } from '../config/api';

import type {
  AgentBaseContext,
  IntentEpisode,
  IntentResponse,
  ResolveActionsResponse,
} from '@sediment/shared';

/**
 * Call the backend intent recognition endpoint.
 */
export async function recognizeIntent(
  canvasContext: AgentBaseContext,
): Promise<IntentResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/intent/recognize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvasContext }),
  });

  if (!response.ok) {
    throw new Error(
      `Intent recognition failed: ${response.status} ${response.statusText}`,
    );
  }

  return response.json() as Promise<IntentResponse>;
}

/**
 * Log an intent episode (user's choice or dismissal) for preference learning.
 */
export async function logIntentEpisode(episode: IntentEpisode): Promise<void> {
  await fetch(`${API_CONFIG.API_URL}/intent/episode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episode }),
  }).catch((err) => {
    console.error('[intent] Failed to log episode:', err);
  });
}

/**
 * Call the backend to resolve a chosen intent into a concrete action list.
 */
export async function resolveActions(
  canvasContext: AgentBaseContext,
  chosenIntent: string,
): Promise<ResolveActionsResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/intent/resolve-actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canvasContext, chosenIntent }),
  });

  if (!response.ok) {
    throw new Error(
      `Action resolution failed: ${response.status} ${response.statusText}`,
    );
  }

  return response.json() as Promise<ResolveActionsResponse>;
}
