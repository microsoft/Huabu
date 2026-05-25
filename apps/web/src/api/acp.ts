/**
 * ACP (external agent bridge) API client.
 *
 * Phase 2 PR A — exposes the read-only `GET /api/acp/agents` endpoint.
 * The endpoint is always registered server-side: when the bridge is
 * disabled it returns `{ enabled: false, agents: [] }`, so callers don't
 * need to know about `SEDIMENT_ENABLE_ACP` themselves.
 */

import { apiFetch } from './_client';
import { routes } from './_routes';

import type { AcpAgentsResponse } from '@sediment/shared';

export type { AcpAgentSummary, AcpAgentsResponse } from '@sediment/shared';

/** List currently-connected external ACP agents. */
export async function listAcpAgents(): Promise<AcpAgentsResponse> {
  return apiFetch<AcpAgentsResponse>(routes.acpAgents, {
    fallbackMessage: 'Failed to list ACP agents',
  });
}
