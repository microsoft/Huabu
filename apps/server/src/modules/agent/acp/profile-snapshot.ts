// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getAgentProfileRegistry } from '@agenetes/agentlet-host';

import type { AcpBindingRecipe } from '@agenetes/acp-driver';
import type {
  AgentProfile,
  AgentProfileSnapshot,
} from '@agenetes/agent-profile';

/** The launch identity a conversation freezes from `profile`. */
export function profileSnapshot(profile: AgentProfile): AgentProfileSnapshot {
  return {
    profileId: profile.id,
    agentletId: profile.agentletId,
    workingDirPath: profile.workingDirPath,
    launch: profile.launch,
    executionRevision: profile.executionRevision ?? 0,
  };
}

/**
 * {@link profileSnapshot} of a Profile the caller may use, or `null`. Reads
 * the registry; a caller that also needs the Profile's other fields reads
 * the Profile once and calls {@link profileSnapshot} instead.
 */
export async function resolveProfileSnapshot(
  profileId: string,
): Promise<AgentProfileSnapshot | null> {
  const profile = await getAgentProfileRegistry()?.getProfile(profileId);
  return profile ? profileSnapshot(profile) : null;
}

export function recipeFromProfileSnapshot(
  profile: AgentProfileSnapshot,
  alias: string,
): AcpBindingRecipe {
  return {
    ...(profile.launch.kind === 'acp-command'
      ? { command: profile.launch.command }
      : { launch: profile.launch }),
    cwd: profile.workingDirPath,
    autoRestart: true,
    alias,
  };
}
