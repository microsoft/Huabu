/**
 * ACP (external agent bridge) API client.
 *
 * Wraps the read-only `GET /api/acp/agents` endpoint, the ephemeral
 * pairing-token surface (`POST/GET /api/acp/pair`,
 * `DELETE /api/acp/pair/:id`), and the thread-scoped session / commands
 * endpoints used by the slash-command typeahead.
 *
 * The agents-list endpoint is always registered server-side and now
 * always responds with `{ agents: [...] }` — the bridge is permanently
 * mounted; whether any agent is actually reachable is a function of
 * whether the user has paired one.
 */

import { ApiError, apiFetch } from './_client';
import { routes } from './_routes';

import type {
  AcpAgentsResponse,
  AcpPairingCreatedResponse,
  AcpPairingListResponse,
  AcpPermissionDecisionRequest,
  AcpPermissionDecisionResponse,
  AcpThreadCommandsResponse,
  EnsureAcpSessionRequest,
  EnsureAcpSessionResponse,
  SetAcpSessionConfigOptionRequest,
  SetAcpSessionConfigOptionResponse,
  SetAcpSessionModelRequest,
  SetAcpSessionModelResponse,
  SetAcpSessionModeRequest,
  SetAcpSessionModeResponse,
} from '@sediment/shared';

export type {
  AcpAgentSummary,
  AcpAgentsResponse,
  AcpModelInfo,
  AcpPairingCreatedResponse,
  AcpPairingListResponse,
  AcpPairingTicket,
  AcpSessionConfigOption,
  AcpSessionMetaSnapshot,
  AcpSessionMode,
  AcpThreadCommandsResponse,
  AvailableCommand,
  EnsureAcpSessionRequest,
  EnsureAcpSessionResponse,
  SetAcpSessionConfigOptionRequest,
  SetAcpSessionConfigOptionResponse,
  SetAcpSessionModelRequest,
  SetAcpSessionModelResponse,
  SetAcpSessionModeRequest,
  SetAcpSessionModeResponse,
} from '@sediment/shared';

/** List currently-connected external ACP agents. */
export async function listAcpAgents(): Promise<AcpAgentsResponse> {
  return apiFetch<AcpAgentsResponse>(routes.acpAgents, {
    fallbackMessage: 'Failed to list ACP agents',
  });
}

/**
 * Mint a fresh ephemeral pairing ticket. The returned `code` is valid
 * for 60 seconds; once an agentlet successfully runs `bridge/hello`
 * with that code it gets locked to that agent's `agentId` indefinitely
 * (until graceful disconnect, explicit revoke, or server restart).
 */
export async function createAcpPairing(): Promise<AcpPairingCreatedResponse> {
  return apiFetch<AcpPairingCreatedResponse>(routes.acpPair, {
    method: 'POST',
    fallbackMessage: 'Failed to create pairing code',
  });
}

/** Snapshot every still-active pairing ticket. */
export async function listAcpPairings(): Promise<AcpPairingListResponse> {
  return apiFetch<AcpPairingListResponse>(routes.acpPair, {
    fallbackMessage: 'Failed to read pairing codes',
  });
}

/**
 * Revoke a ticket by id. Returns `{ revoked: false }` when the ticket
 * had already expired / been claimed-then-disconnected — caller can
 * ignore.
 */
export async function revokeAcpPairing(
  id: string,
): Promise<{ revoked: boolean }> {
  return apiFetch<{ revoked: boolean }>(routes.acpPairItem(id), {
    method: 'DELETE',
    fallbackMessage: 'Failed to revoke pairing code',
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

/**
 * Answer an outstanding `session/request_permission` surfaced via a
 * `permission_request` SSE event. Pass either `optionId` (user picked
 * an option) or `cancelled: true` (dismissed). `resolved: false` means
 * no suspended request matched — already answered, timed out, or the
 * session ended; the caller can safely ignore it.
 */
export async function respondAcpPermission(
  threadId: string,
  decision: AcpPermissionDecisionRequest,
): Promise<AcpPermissionDecisionResponse> {
  return apiFetch<AcpPermissionDecisionResponse>(
    routes.acpThreadPermission(threadId),
    {
      method: 'POST',
      json: decision,
      fallbackMessage: 'Failed to submit permission decision',
    },
  );
}

// ── Session-meta set-RPCs ──────────────────────────────────────────
//
// Thin wrappers around POST `/threads/:threadId/{mode,model,config-option}`.
// The agent confirms successful switches via SSE (`session_mode_update`
// / `config_options_update`) — UI updates its dropdowns from THAT, not
// the optimistic ack returned by these calls. We keep the ack typed so
// callers can show a loading spinner that clears on resolve / reject.

/** Switch the session's currently-active mode (e.g. Copilot "plan"). */
export async function setAcpSessionMode(
  threadId: string,
  payload: SetAcpSessionModeRequest,
): Promise<SetAcpSessionModeResponse> {
  return apiFetch<SetAcpSessionModeResponse>(routes.acpThreadMode(threadId), {
    method: 'POST',
    json: payload,
    fallbackMessage: 'Failed to switch session mode',
  });
}

/** Switch the session's currently-active model. */
export async function setAcpSessionModel(
  threadId: string,
  payload: SetAcpSessionModelRequest,
): Promise<SetAcpSessionModelResponse> {
  return apiFetch<SetAcpSessionModelResponse>(routes.acpThreadModel(threadId), {
    method: 'POST',
    json: payload,
    fallbackMessage: 'Failed to switch session model',
  });
}

/** Change a single session config knob (e.g. thought-level, auto-approve). */
export async function setAcpSessionConfigOption(
  threadId: string,
  payload: SetAcpSessionConfigOptionRequest,
): Promise<SetAcpSessionConfigOptionResponse> {
  return apiFetch<SetAcpSessionConfigOptionResponse>(
    routes.acpThreadConfigOption(threadId),
    {
      method: 'POST',
      json: payload,
      fallbackMessage: 'Failed to update session config option',
    },
  );
}
