import { apiFetch, apiUrl } from './_client';
import { routes } from './_routes';

import type {
  AgentProfileView,
  AgentTeamMemberDetailView,
  AgentTeamRootRefBody,
  AgentTeamSettingsState,
  CreateAgentProfileBody,
  PatchAgentProfileBody,
  UpdateAgentTeamMemberConfigsBody,
} from '@sediment/shared';

export async function getAgentTeamSettings(): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamSettings, {
    fallbackMessage: 'Failed to load Agent Team Settings',
  });
}

export async function addAgentTeamRoot(
  root: AgentTeamRootRefBody,
): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamRoots, {
    method: 'POST',
    json: root,
    fallbackMessage: 'Failed to add Agent Team root',
  });
}

export async function rescanAgentTeamRoot(
  root: AgentTeamRootRefBody,
): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamRootsRescan, {
    method: 'POST',
    json: root,
    fallbackMessage: 'Failed to rescan Agent Team root',
  });
}

export async function removeAgentTeamRoot(
  root: AgentTeamRootRefBody,
): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamRoots, {
    method: 'DELETE',
    json: root,
    fallbackMessage: 'Failed to remove Agent Team root',
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
  profile: CreateAgentProfileBody,
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

export interface AgentTeamSettingsStreamError {
  message: string;
  code?: string;
}

export function subscribeAgentTeamSettings(
  onSnapshot: (state: AgentTeamSettingsState) => void,
  onStateError?: (error: AgentTeamSettingsStreamError) => void,
): () => void {
  const source = new EventSource(apiUrl(routes.agentTeamSettingsEvents));
  source.addEventListener('snapshot', (event) => {
    let state: AgentTeamSettingsState;
    try {
      state = JSON.parse(event.data) as AgentTeamSettingsState;
    } catch {
      onStateError?.({
        message: 'Agent Team Settings stream returned invalid data',
        code: 'invalid_stream_data',
      });
      source.close();
      return;
    }
    onSnapshot(state);
  });
  source.addEventListener('state-error', (event) => {
    let streamError: AgentTeamSettingsStreamError;
    try {
      streamError = JSON.parse(event.data) as AgentTeamSettingsStreamError;
    } catch {
      onStateError?.({
        message: 'Agent Team Settings stream returned an invalid error',
        code: 'invalid_stream_error',
      });
      source.close();
      return;
    }
    onStateError?.(streamError);
    source.close();
  });
  source.onerror = () => {
    onStateError?.({
      message: 'Agent Team Settings stream disconnected',
      code: 'stream_disconnected',
    });
  };
  return () => source.close();
}
