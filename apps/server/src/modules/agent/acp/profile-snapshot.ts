// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getAgentProfileRegistry } from '@agenetes/agentlet-host';

import type { AcpBindingRecipe } from '@agenetes/acp-driver';
import type { AgentProfileSnapshot } from '@agenetes/agent-profile';

export function resolveProfileSnapshot(
  profileId: string,
): AgentProfileSnapshot | null {
  const profile = getAgentProfileRegistry()?.getProfile(profileId);
  if (!profile) return null;
  return {
    profileId: profile.id,
    agentletId: profile.agentletId,
    workingDirPath: profile.workingDirPath,
    launch: profile.launch,
    executionRevision: profile.executionRevision ?? 0,
  };
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
