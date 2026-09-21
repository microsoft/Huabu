// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ACP (external agent bridge) API client.
 *
 * The bridge now uses an **embedded agentlet daemon** managed by the
 * server's `DaemonSupervisor`. The user never sees the daemon directly
 * — instead they author command Profiles which
 * describe how to spawn one external agent CLI on demand. This module
 * wraps the loopback-only profile/daemon endpoints plus the existing
 * thread-scoped cached capability and control routes.
 *
 * Endpoint surface:
 *  - `GET /api/acp/agent-cli` — read the daemon's detected agent catalogue
 *     and populate the profile editor's picker with installation state.
 *  - `GET/POST/PATCH/DELETE /api/acp/profiles` — CRUD for spawn
 *     recipes with revision-checked launch and working-directory edits.
 *  - `POST /api/acp/profile-launch-preview` — daemon-built launch preview.
 *  - `GET/POST /api/acp/daemon` — daemon liveness + manual restart.
 *  - `GET /api/acp/threads/:threadId/cached-meta` — cached capabilities.
 *  - thread control POSTs — canonical realization plus per-session knobs.
 */

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  AcpAgentCliListResponse,
  AcpAgentletStatus,
  AcpAgentletStatusResponse,
  AcpPermissionDecisionRequest,
  AcpPermissionDecisionResponse,
  AcpProfileMutationResponse,
  AcpProfileLaunchPreviewBody,
  AcpProfileLaunchPreviewResponse,
  AcpProfilesListResponse,
  CreateAcpProfileBody,
  PatchAgentProfileBody,
  AcpThreadCachedMetaResponse,
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
  AcpProfileLaunchPreviewBody,
  AcpProfileLaunchPreviewResponse,
  AcpProfilesListResponse,
  CreateAcpCommandProfileBody,
  CreateAcpProfileBody,
  PatchAgentProfileBody,
  AgentProfileView,
  AcpSessionConfigOption,
  AcpSessionMetaSnapshot,
  AcpSessionMode,
  AcpThreadCachedMetaResponse,
  AvailableCommand,
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
 * Read the supervised daemon's catalogue, or the saved Profile's target daemon.
 */
export async function listAcpAgentClis(
  profileId?: string,
): Promise<AcpAgentCliListResponse> {
  return apiFetch<AcpAgentCliListResponse>(routes.acpAgentCli(profileId), {
    fallbackMessage: 'Failed to detect installed agent CLIs',
  });
}

// ── Profile CRUD ─────────────────────────────────────────────────────

/** Snapshot every Profile, selectability, and the current agentlet status. */
export async function listAcpProfiles(): Promise<AcpProfilesListResponse> {
  return apiFetch<AcpProfilesListResponse>(routes.acpProfiles, {
    fallbackMessage: 'Failed to list agent profiles',
  });
}

/**
 * Create a command Profile on the local agentlet. The server allocates its id.
 */
export async function createAcpProfile(
  payload: CreateAcpProfileBody,
): Promise<AcpProfileMutationResponse> {
  return apiFetch<AcpProfileMutationResponse>(routes.acpProfiles, {
    method: 'POST',
    json: payload,
    fallbackMessage: 'Failed to create agent profile',
  });
}

/** Resolve a launch on the target daemon without starting an execution. */
export async function previewAcpProfileLaunch(
  body: AcpProfileLaunchPreviewBody,
): Promise<AcpProfileLaunchPreviewResponse> {
  return apiFetch<AcpProfileLaunchPreviewResponse>(
    routes.acpProfileLaunchPreview,
    {
      method: 'POST',
      json: body,
      fallbackMessage: 'Failed to preview agent launch',
    },
  );
}

/**
 * Patch a Profile at its expected revision; omitted fields remain intact.
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

/**
 * Fetch the GET-only capability observation for a thread and its Profile.
 * This never creates a workload or starts an ACP process.
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
