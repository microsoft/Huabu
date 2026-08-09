// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getAgentTeamRegistry } from '@agenetes/agentlet-host';

import type { CustomData } from '@huabu/shared';

export interface SelectableAgentProfile {
  id: string;
  alias: string;
  customData?: CustomData;
}

interface AgentProfileRegistryPort {
  getProfile(profileId: string): SelectableAgentProfile | null | undefined;
  listSelectableProfileIds(): string[];
}

export interface SelectableAgentProfileSummary {
  id: string;
  alias: string;
}

export class SelectableAgentProfileError extends Error {
  constructor(
    public readonly code: 'registry_unavailable' | 'profile_not_selectable',
    message: string,
  ) {
    super(message);
    this.name = 'SelectableAgentProfileError';
  }
}

export function requireSelectableAgentProfile(
  profileId: string,
  registry: AgentProfileRegistryPort | null = getAgentTeamRegistry(),
): SelectableAgentProfile {
  if (!registry) {
    throw new SelectableAgentProfileError(
      'registry_unavailable',
      'Agent Profile registry is not ready',
    );
  }
  const profile = registry.getProfile(profileId);
  if (
    !profile ||
    !new Set(registry.listSelectableProfileIds()).has(profile.id)
  ) {
    throw new SelectableAgentProfileError(
      'profile_not_selectable',
      `Agent Profile ${profileId} is not selectable`,
    );
  }
  return profile;
}

export function listSelectableAgentProfiles(
  registry: AgentProfileRegistryPort | null = getAgentTeamRegistry(),
): SelectableAgentProfileSummary[] {
  if (!registry) {
    throw new SelectableAgentProfileError(
      'registry_unavailable',
      'Agent Profile registry is not ready',
    );
  }
  return registry.listSelectableProfileIds().map((profileId) => {
    const profile = registry.getProfile(profileId);
    if (!profile) {
      throw new Error(
        `Selectable Agent Profile ${profileId} is missing from the registry`,
      );
    }
    return { id: profile.id, alias: profile.alias };
  });
}
