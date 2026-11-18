// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getAgentProfileRegistry,
  resolveConnectedAgentletId,
} from '@agenetes/agentlet-host';

import { HUABU_AGENT_PROFILE_ID } from '@huabu/shared';

import type { CustomData } from '@huabu/shared';

export interface SelectableAgentProfile {
  id: string;
  alias: string;
  customData?: CustomData;
}

/** The registry as Agent selection sees it. */
export interface AgentProfileRegistryPort {
  /**
   * Visible Profiles the caller may use whose device is connected, in
   * registry order. One call reads the registry once.
   */
  listSelectableProfiles(): Promise<SelectableAgentProfile[]>;
}

function getConnectedProfileRegistry(): AgentProfileRegistryPort | null {
  const registry = getAgentProfileRegistry();
  if (!registry) return null;
  return {
    listSelectableProfiles: async () =>
      (await registry.listProfiles()).filter(
        (profile) =>
          profile.visible !== false &&
          resolveConnectedAgentletId(profile.agentletId),
      ),
  };
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

export async function requireSelectableAgentProfile(
  profileId: string,
  registry: AgentProfileRegistryPort | null = getConnectedProfileRegistry(),
): Promise<SelectableAgentProfile> {
  if (!registry) {
    throw new SelectableAgentProfileError(
      'registry_unavailable',
      'Agent Profile registry is not ready',
    );
  }

  const profile = (await registry.listSelectableProfiles()).find(
    ({ id }) => id === profileId,
  );
  if (!profile) {
    throw new SelectableAgentProfileError(
      'profile_not_selectable',
      `Agent Profile ${profileId} is not selectable`,
    );
  }
  return profile;
}

export async function requireAvailableAgentProfile(
  profileId: string,
  registry: AgentProfileRegistryPort | null = getConnectedProfileRegistry(),
): Promise<void> {
  if (profileId === HUABU_AGENT_PROFILE_ID) return;
  await requireSelectableAgentProfile(profileId, registry);
}

/** The Profile a new conversation uses when none is chosen. */
export async function getFirstSelectableAgentProfile(
  registry: AgentProfileRegistryPort | null = getConnectedProfileRegistry(),
): Promise<SelectableAgentProfile | null> {
  return (await registry?.listSelectableProfiles())?.[0] ?? null;
}

export async function getFirstSelectableAgentProfileId(
  registry: AgentProfileRegistryPort | null = getConnectedProfileRegistry(),
): Promise<string | null> {
  return (await getFirstSelectableAgentProfile(registry))?.id ?? null;
}

export async function listAvailableAgentProfiles(
  registry: AgentProfileRegistryPort | null = getConnectedProfileRegistry(),
): Promise<AvailableAgentProfileSummary[]> {
  const huabu = {
    id: HUABU_AGENT_PROFILE_ID,
    alias: 'Built-In Pi',
  } as const;
  if (!registry) {
    return [huabu];
  }
  const selectable = await registry.listSelectableProfiles();
  return [
    huabu,
    ...selectable.map((profile, index) => ({
      id: profile.id,
      alias: profile.alias,
      ...(index === 0 ? { default: true } : {}),
    })),
  ];
}
