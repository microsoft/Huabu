// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getAgentTeamRegistry } from '@agenetes/agentlet-host';

import { HUABU_AGENT_PROFILE_ID } from '@huabu/shared';

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

export interface AvailableAgentProfileSummary {
  id: string;
  alias: string;
  default?: boolean;
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

export function requireAvailableAgentProfile(
  profileId: string,
  registry: AgentProfileRegistryPort | null = getAgentTeamRegistry(),
): void {
  if (profileId === HUABU_AGENT_PROFILE_ID) return;
  requireSelectableAgentProfile(profileId, registry);
}

export function listAvailableAgentProfiles(
  registry: AgentProfileRegistryPort | null = getAgentTeamRegistry(),
): AvailableAgentProfileSummary[] {
  const huabu = {
    id: HUABU_AGENT_PROFILE_ID,
    alias: 'Huabu',
    default: true,
  } as const;
  if (!registry) {
    return [huabu];
  }
  return [
    huabu,
    ...registry.listSelectableProfileIds().map((profileId) => {
      const profile = registry.getProfile(profileId);
      if (!profile) {
        throw new Error(
          `Selectable Agent Profile ${profileId} is missing from the registry`,
        );
      }
      return { id: profile.id, alias: profile.alias };
    }),
  ];
}
