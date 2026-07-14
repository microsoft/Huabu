import { apiFetch, apiUrl } from './_client';
import { routes } from './_routes';

import type {
  AgentTeamRootRefBody,
  AgentTeamSettingsState,
  CreateAgentTeamDeploymentBody,
  UpdateAgentTeamDeploymentBody,
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

export async function updateAgentTeamConfigs(
  update: UpdateAgentTeamMemberConfigsBody,
): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamConfigs, {
    method: 'PUT',
    json: update,
    fallbackMessage: 'Failed to update Agent Team Configs',
  });
}

export async function createAgentTeamDeployment(
  deployment: CreateAgentTeamDeploymentBody,
): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamDeployments, {
    method: 'POST',
    json: deployment,
    fallbackMessage: 'Failed to create Agent Team deployment',
  });
}

export async function updateAgentTeamDeployment(
  id: string,
  update: UpdateAgentTeamDeploymentBody,
): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamDeployment(id), {
    method: 'PATCH',
    json: update,
    fallbackMessage: 'Failed to update Agent Team deployment',
  });
}

export async function deleteAgentTeamDeployment(
  id: string,
): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamDeployment(id), {
    method: 'DELETE',
    fallbackMessage: 'Failed to delete Agent Team deployment',
  });
}

async function runDeploymentAction(
  id: string,
  action: 'enable' | 'disable' | 'retry',
): Promise<AgentTeamSettingsState> {
  return apiFetch(routes.agentTeamDeploymentAction(id, action), {
    method: 'POST',
    fallbackMessage: `Failed to ${action} Agent Team deployment`,
  });
}

export function enableAgentTeamDeployment(
  id: string,
): Promise<AgentTeamSettingsState> {
  return runDeploymentAction(id, 'enable');
}

export function disableAgentTeamDeployment(
  id: string,
): Promise<AgentTeamSettingsState> {
  return runDeploymentAction(id, 'disable');
}

export function retryAgentTeamDeploymentSetup(
  id: string,
): Promise<AgentTeamSettingsState> {
  return runDeploymentAction(id, 'retry');
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
