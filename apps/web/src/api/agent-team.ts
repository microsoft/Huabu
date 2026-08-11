// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  AgentProfileView,
  AgentTeamMemberDetailView,
  AgentTeamSettingsState,
  CreateAgentTeamProfileBody,
  PatchAgentProfileBody,
  UpdateAgentTeamMemberConfigsBody,
} from '@huabu/shared';

export async function getAgentTeamSettings(): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamSettings, {
    fallbackMessage: 'Failed to load Agent Team Settings',
  });
}

export async function getAgentTeamMemberDetail(
  member: Pick<AgentTeamMemberDetailView['member'], 'machine' | 'manifestPath'>,
): Promise<AgentTeamMemberDetailView> {
  const query = new URLSearchParams({
    machine: member.machine,
    manifestPath: member.manifestPath,
  });
  return apiFetch(`${routes.agentTeamMemberDetail}?${query}`, {
    fallbackMessage: 'Failed to load Agent Team member',
  });
}

export async function updateAgentTeamConfigs(
  update: UpdateAgentTeamMemberConfigsBody,
): Promise<AgentTeamMemberDetailView> {
  return apiFetch(routes.agentTeamConfigs, {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to update Agent Team Configs',
  });
}

export async function createAgentTeamProfile(
  profile: CreateAgentTeamProfileBody,
): Promise<AgentProfileView> {
  return apiFetch(routes.agentTeamProfiles, {
    method: 'POST',
    json: profile,
    fallbackMessage: 'Failed to create Agent Team Profile',
  });
}

export async function patchAgentTeamProfile(
  id: string,
  update: PatchAgentProfileBody,
): Promise<AgentProfileView> {
  return apiFetch(routes.agentTeamProfile(id), {
    method: 'PATCH',
    json: update,
    fallbackMessage: 'Failed to update Agent Team Profile',
  });
}

export async function deleteAgentTeamProfile(
  id: string,
): Promise<{ deleted: true }> {
  return apiFetch(routes.agentTeamProfile(id), {
    method: 'DELETE',
    fallbackMessage: 'Failed to delete Agent Team Profile',
  });
}

async function runProfileAction(
  id: string,
  action: 'setup' | 'cancel',
): Promise<AgentProfileView> {
  return apiFetch(routes.agentTeamProfileAction(id, action), {
    method: 'POST',
    fallbackMessage: `Failed to ${action} Agent Team Profile`,
  });
}

export function setupAgentTeamProfile(id: string): Promise<AgentProfileView> {
  return runProfileAction(id, 'setup');
}

export function cancelAgentTeamProfileSetup(
  id: string,
): Promise<AgentProfileView> {
  return runProfileAction(id, 'cancel');
}
