// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ACP (external agent bridge) API client.
 *
 * The bridge now uses an **embedded agentlet daemon** managed by the
 * server's `DaemonSupervisor`. The user never sees the daemon directly
 * — instead they author **profiles** ({@link AcpAgentProfile}) which
 * describe how to spawn one external agent CLI on demand. This module
 * wraps the loopback-only profile/daemon endpoints plus the existing
 * thread-scoped session / commands routes.
 *
 * Endpoint surface:
 *  - `GET /api/acp/agent-cli` — probe the trusted built-in agent catalogue
 *     and populate the profile editor's picker with installation state.
 *  - `GET/POST/PATCH/DELETE /api/acp/profiles` — CRUD for spawn
 *     recipes. Always returns the runtime status (spawned/pid/etc.)
 *     alongside each profile.
 *  - `GET/POST /api/acp/daemon` — daemon liveness + manual restart.
 *  - `POST /api/acp/threads/:threadId/session` etc. — thread-scoped
 *     session lifecycle and per-session config knobs.
 */

import { ApiError, apiFetch } from './_client';
import { routes } from './_routes';

import type {
  AcpAgentCliListResponse,
  AcpAgentletStatus,
  AcpAgentletStatusResponse,
  AcpPermissionDecisionRequest,
  AcpPermissionDecisionResponse,
  AcpProfileMutationResponse,
  AcpProfilesListResponse,
  CreateAcpCommandProfileBody,
  PatchAgentProfileBody,
  AcpThreadCachedMetaResponse,
  AcpThreadCommandsResponse,
  EnsureAcpSessionRequest,
  EnsureAcpSessionResponse,
  SetAcpSessionConfigOptionRequest,
  SetAcpSessionConfigOptionResponse,
  SetAcpSessionModelRequest,
  SetAcpSessionModelResponse,
  SetAcpSessionModeRequest,
  SetAcpSessionModeResponse,
  ExternalAgentRuntimeConfig,
} from '@huabu/shared';

export type {
  AcpAgentCliInfo,
  AcpAgentCliListResponse,
  AcpAgentProfile,
  AcpAgentletStatus,
  AcpAgentletStatusResponse,
  AcpModelInfo,
  AcpProfileMutationResponse,
  AcpProfilesListResponse,
  CreateAcpCommandProfileBody,
  PatchAgentProfileBody,
  AgentProfileView,
  AcpSessionConfigOption,
  AcpSessionMetaSnapshot,
  AcpSessionMode,
  AcpThreadCachedMetaResponse,
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
  ExternalAgentRuntimeConfig,
} from '@huabu/shared';

// ── Agent CLI detection ──────────────────────────────────────────────

/**
 * Probe the complete trusted ACP-capable agent catalogue on the host.
 */
export async function listAcpAgentClis(): Promise<AcpAgentCliListResponse> {
  return apiFetch<AcpAgentCliListResponse>(routes.acpAgentCli, {
    fallbackMessage: 'Failed to detect installed agent CLIs',
  });
}

// ── Profile CRUD ─────────────────────────────────────────────────────

/** Snapshot every profile with its current runtime status. */
export async function listAcpProfiles(): Promise<AcpProfilesListResponse> {
  return apiFetch<AcpProfilesListResponse>(routes.acpProfiles, {
    fallbackMessage: 'Failed to list agent profiles',
  });
}

/**
 * Create a new profile. The server allocates an id and timestamps;
 * the request body only carries the user-edited fields. Returns the
 * fully-formed profile + initial runtime (`spawned: false`).
 */
export async function createAcpProfile(
  payload: CreateAcpCommandProfileBody,
): Promise<AcpProfileMutationResponse> {
  return apiFetch<AcpProfileMutationResponse>(routes.acpProfiles, {
    method: 'POST',
    json: payload,
    fallbackMessage: 'Failed to create agent profile',
  });
}

/**
 * Patch an existing profile. Any field present in the patch replaces
 * the stored value; omitted fields are left intact. Pass `env: null`
 * to clear all env vars; pass an object to replace the env map.
 */
export async function updateAcpProfile(
  id: string,
  payload: PatchAgentProfileBody,
): Promise<AcpProfileMutationResponse> {
  return apiFetch<AcpProfileMutationResponse>(routes.acpProfileItem(id), {
    method: 'PATCH',
    json: payload,
    fallbackMessage: 'Failed to update agent profile',
  });
}

/**
 * Delete a profile and (best-effort) ask the daemon to stop the
 * underlying agent process. Returns `{deleted: false}` when the id
 * didn't exist (e.g. the user double-clicked Delete) — caller can
 * treat that as success.
 */
export async function deleteAcpProfile(
  id: string,
): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>(routes.acpProfileItem(id), {
    method: 'DELETE',
    fallbackMessage: 'Failed to delete agent profile',
  });
}

// ── Agentlet status ──────────────────────────────────────────────────

/**
 * Fetch the embedded agentlet's liveness snapshot. The UI uses this
 * to render the amber troubleshooting banner when `online: false`
 * and `lastError` is non-empty.
 */
export async function getAcpAgentletStatus(): Promise<AcpAgentletStatus> {
  return apiFetch<AcpAgentletStatusResponse>(routes.acpAgentlet, {
    fallbackMessage: 'Failed to read agentlet status',
  });
}

/**
 * Force the supervisor to re-fork the agentlet immediately, resetting
 * backoff state. Triggered by the "Restart worker" button in
 * Settings → External Agents.
 */
export async function restartAcpAgentlet(): Promise<AcpAgentletStatus> {
  return apiFetch<AcpAgentletStatusResponse>(routes.acpAgentletRestart, {
    method: 'POST',
    fallbackMessage: 'Failed to restart agentlet',
  });
}

export async function getExternalAgentRuntimeConfig(): Promise<ExternalAgentRuntimeConfig> {
  return apiFetch<ExternalAgentRuntimeConfig>(routes.acpRuntimeConfig, {
    fallbackMessage: 'Failed to read external-agent runtime settings',
  });
}

export async function updateExternalAgentRuntimeConfig(
  config: ExternalAgentRuntimeConfig,
): Promise<ExternalAgentRuntimeConfig> {
  return apiFetch<ExternalAgentRuntimeConfig>(routes.acpRuntimeConfig, {
    method: 'PUT',
    json: config,
    fallbackMessage: 'Failed to update external-agent runtime settings',
  });
}

// ── Per-thread session lifecycle ─────────────────────────────────────

/**
 * Eagerly open (or reuse) the per-thread ACP session so the slash-command
 * typeahead can pull commands BEFORE the user submits their first prompt.
 * Idempotent: calling repeatedly with the same `{threadId, profileId,
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
  canvasId?: string,
): Promise<AcpThreadCommandsResponse | null> {
  try {
    return await apiFetch<AcpThreadCommandsResponse>(
      routes.acpThreadCommands(threadId, canvasId),
      { fallbackMessage: 'Failed to fetch ACP slash commands' },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Fetch the server-cached session-meta snapshot WITHOUT spawning the
 * agentlet. Always resolves to a snapshot (possibly the empty
 * `updatedAt === 0` form) — the server returns 200 even on cache
 * miss so the UI can render an optimistic neutral state.
 *
 * Used by `useAcpSessionMeta` on mount to populate selector dropdowns
 * (model / mode / config options) from the last-known state of the
 * thread, so the user can pre-select a model before sending the first
 * message without paying the cold-start tax of `ensureAcpSession`.
 */
export async function getAcpThreadCachedMeta(
  threadId: string,
  canvasId?: string,
  profileId?: string,
): Promise<AcpThreadCachedMetaResponse> {
  return apiFetch<AcpThreadCachedMetaResponse>(
    routes.acpThreadCachedMeta(threadId, canvasId, profileId),
    { fallbackMessage: 'Failed to fetch ACP session meta cache' },
  );
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
