/**
 * ACP (external agent bridge) API client.
 *
 * Wraps the read-only `GET /api/acp/agents` endpoint and the
 * thread-scoped session / commands endpoints used by the slash-command
 * typeahead.
 *
 * The agents-list endpoint is always registered server-side: when the
 * bridge is disabled it returns `{ enabled: false, agents: [] }`, so
 * callers don't need to know about `SEDIMENT_ENABLE_ACP` themselves.
 * The thread-scoped endpoints, by contrast, are only mounted when the
 * bridge is enabled — calls to them on a disabled server respond 404.
 */

import { ApiError, apiFetch } from './_client';
import { routes } from './_routes';

import type {
  AcpAgentsResponse,
  AcpThreadCommandsResponse,
  EnsureAcpSessionRequest,
  EnsureAcpSessionResponse,
} from '@sediment/shared';

export type {
  AcpAgentSummary,
  AcpAgentsResponse,
  AcpThreadCommandsResponse,
  AvailableCommand,
  EnsureAcpSessionRequest,
  EnsureAcpSessionResponse,
} from '@sediment/shared';

/** List currently-connected external ACP agents. */
export async function listAcpAgents(): Promise<AcpAgentsResponse> {
  return apiFetch<AcpAgentsResponse>(routes.acpAgents, {
    fallbackMessage: 'Failed to list ACP agents',
  });
}

/**
 * Eagerly open (or reuse) the per-thread ACP session so the slash-command
 * typeahead can pull commands BEFORE the user submits their first prompt.
 * Idempotent: calling repeatedly with the same `{threadId, agentletAgentId,
 * canvasId}` triple is a no-op server-side.
 *
 * Response always carries the latest `availableCommands`; an empty array
 * means the agent has not yet pushed its list — callers should follow up
 * with {@link getAcpThreadCommands} after a short delay to catch late pushes.
 */
export async function ensureAcpSession(
  threadId: string,
  payload: EnsureAcpSessionRequest,
): Promise<EnsureAcpSessionResponse> {
  return apiFetch<EnsureAcpSessionResponse>(routes.acpThreadSession(threadId), {
    method: 'POST',
    json: payload,
    fallbackMessage: 'Failed to open ACP session',
  });
}

/**
 * Read the cached slash-command snapshot for an existing session.
 * Returns `null` when the server has no session for this thread yet
 * (404) so callers can ignore the missing-session case without
 * branching on `ApiError.status`.
 */
export async function getAcpThreadCommands(
  threadId: string,
): Promise<AcpThreadCommandsResponse | null> {
  try {
    return await apiFetch<AcpThreadCommandsResponse>(
      routes.acpThreadCommands(threadId),
      { fallbackMessage: 'Failed to fetch ACP slash commands' },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
