// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ACP (external agent bridge) API client.
 *
 * The bridge uses local or remote execution-machine agentlets. Users select
 * discovered Agents or author **profiles** ({@link AcpAgentProfile}) that
 * describe how to spawn an external agent CLI on demand.
 *
 * Endpoint surface:
 *  - `GET /api/acp/agent-cli` — read cached machine-scoped discovery.
 *  - `POST /api/acp/agent-cli/refresh` — refresh target-machine discovery.
 *  - `GET/POST/PATCH/DELETE /api/acp/profiles` — CRUD for spawn
 *     recipes. Always returns the runtime status (spawned/pid/etc.)
 *     alongside each profile.
 *  - `GET/POST /api/acp/daemon` — daemon liveness + manual restart.
 *  - `GET /api/acp/threads/:threadId/cached-meta` — cached capabilities.
 *  - thread control POSTs — canonical realization plus per-session knobs.
 */

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  AcpAgentCliListResponse,
  AcpAgentCliInfo,
  AcpAgentletStatus,
  AcpAgentletStatusResponse,
  AcpPermissionDecisionRequest,
  AcpPermissionDecisionResponse,
  AcpProfileMutationResponse,
  AcpProfilesListResponse,
  CreateAcpCommandProfileBody,
  PatchAgentProfileBody,
  AcpThreadCachedMetaResponse,
  SetAcpSessionConfigOptionRequest,
  SetAcpSessionConfigOptionResponse,
  SetAcpSessionModelRequest,
  SetAcpSessionModelResponse,
  SetAcpSessionModeRequest,
  SetAcpSessionModeResponse,
  ExternalAgentRuntimeConfig,
  MaterializeDiscoveredAgentRequest,
  RefreshAcpAgentCliRequest,
  ValidateAcpWorkingDirectoryRequest,
  ValidateAcpWorkingDirectoryResponse,
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
  AvailableCommand,
  SetAcpSessionConfigOptionRequest,
  SetAcpSessionConfigOptionResponse,
  SetAcpSessionModelRequest,
  SetAcpSessionModelResponse,
  SetAcpSessionModeRequest,
  SetAcpSessionModeResponse,
  ExternalAgentRuntimeConfig,
  AcpAgentMachineDiscovery,
  AcpDiscoveredAgent,
  AcpThreadRealization,
  MaterializeDiscoveredAgentRequest,
  RefreshAcpAgentCliRequest,
  ValidateAcpWorkingDirectoryRequest,
  ValidateAcpWorkingDirectoryResponse,
} from '@huabu/shared';

// ── Agent CLI detection ──────────────────────────────────────────────

/**
 * Read cached discovery for the trusted ACP-capable Agent catalogue.
 */
export async function listAcpAgentClis(): Promise<AcpAgentCliListResponse> {
  return apiFetch<AcpAgentCliListResponse>(routes.acpAgentCli, {
    fallbackMessage: 'Failed to detect installed agent CLIs',
  });
}

export function flattenAcpAgentCatalogue(
  response: AcpAgentCliListResponse,
): AcpAgentCliInfo[] {
  const byHarness = new Map<string, AcpAgentCliInfo>();
  for (const machine of response.machines) {
    for (const agent of machine.agents) {
      const previous = byHarness.get(agent.harnessId);
      if (previous?.installed) continue;
      byHarness.set(agent.harnessId, {
        id: agent.harnessId,
        displayName: agent.displayName,
        binary: agent.binary,
        acpArgs: agent.acpArgs,
        autoApprove: agent.autoApprove,
        installHint: agent.installHint,
        installed: agent.status === 'installed',
        ...(agent.version ? { version: agent.version } : {}),
      });
    }
  }
  return [...byHarness.values()];
}

export async function refreshAcpAgentClis(
  payload: RefreshAcpAgentCliRequest = {},
): Promise<AcpAgentCliListResponse> {
  return apiFetch<AcpAgentCliListResponse>(routes.acpAgentCliRefresh, {
    method: 'POST',
    json: payload,
    fallbackMessage: 'Failed to refresh execution-machine agents',
  });
}

export async function materializeDiscoveredAgent(
  payload: MaterializeDiscoveredAgentRequest,
): Promise<AcpProfileMutationResponse> {
  return apiFetch<AcpProfileMutationResponse>(routes.acpAgentCliMaterialize, {
    method: 'POST',
    json: payload,
    fallbackMessage: 'Failed to save discovered agent',
  });
}

export async function validateAcpWorkingDirectory(
  payload: ValidateAcpWorkingDirectoryRequest,
): Promise<ValidateAcpWorkingDirectoryResponse> {
  return apiFetch<ValidateAcpWorkingDirectoryResponse>(
    routes.acpWorkingDirectoryValidate,
    {
      method: 'POST',
      json: payload,
      fallbackMessage: 'Failed to validate working directory',
    },
  );
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
