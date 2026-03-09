/**
 * Intent recognition API client.
 */

import { API_CONFIG } from '../config/api';

import type {
  AgentBaseContext,
  IntentEpisode,
  IntentResponse,
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
