/**
 * Intent recognition API client.
 */

import { API_CONFIG } from '../config/api';

import type { AgentBaseContext, IntentResponse } from '@sediment/shared';

/**
 * Call the backend intent recognition endpoint.
 *
 * @param canvasContext - The lightweight canvas snapshot
 * @returns Ranked list of intent candidates
 */
export async function recogniseIntent(
  canvasContext: AgentBaseContext,
): Promise<IntentResponse> {
  const response = await fetch(`${API_CONFIG.API_URL}/intent/recognise`, {
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
