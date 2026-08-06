// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CreateAcpCommandProfileInput } from '@agenetes/agent-team';
import type { AcpAgentProfile } from '@huabu/shared';

/**
 * Convert spawnable legacy ACP profiles into unified command Profiles.
 *
 * Older records may omit `cwd`; the old launcher then inherited the host
 * process directory, so migration makes that implicit behavior explicit.
 */
export function buildLegacyCommandProfiles(
  profiles: AcpAgentProfile[],
  agentletId: string,
  defaultWorkingDir: string,
): CreateAcpCommandProfileInput[] {
  return profiles.flatMap((profile) =>
    profile.cliId === 'agent-team' || !profile.command
      ? []
      : [
          {
            id: profile.id,
            alias: profile.displayName,
            agentletId,
            command: profile.command,
            workingDirPath: profile.cwd ?? defaultWorkingDir,
            metadata: { cliId: profile.cliId },
          },
        ],
  );
}
