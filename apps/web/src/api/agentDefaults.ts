// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type { AgentDefaults, AgentDefaultsResponse } from '@huabu/shared';
import type {
  ConversationAgentPreference,
  ConversationAgentPreferenceResponse,
} from '@huabu/shared';

export function getAgentDefaults(): Promise<AgentDefaultsResponse> {
  return apiFetch(routes.agentDefaults, {
    fallbackMessage: 'Failed to load Agent defaults',
  });
}

export function updateAgentDefaults(
  config: AgentDefaults,
): Promise<AgentDefaultsResponse> {
  return apiFetch(routes.agentDefaults, {
    method: 'PUT',
    json: config,
    fallbackMessage: 'Failed to save Agent defaults',
  });
}

export function getConversationAgentPreference(): Promise<ConversationAgentPreferenceResponse> {
  return apiFetch(routes.conversationAgent, {
    fallbackMessage: 'Failed to load conversation Agent preference',
  });
}

export function updateConversationAgentPreference(
  preference: ConversationAgentPreference,
): Promise<ConversationAgentPreferenceResponse> {
  return apiFetch(routes.conversationAgent, {
    method: 'PUT',
    json: preference,
    fallbackMessage: 'Failed to save conversation Agent preference',
  });
}
