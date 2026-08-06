// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { buildLegacyCommandProfiles } from './legacy-profile-migration.js';

import type { AcpAgentProfile } from '@huabu/shared';

function makeProfile(
  overrides: Partial<AcpAgentProfile> = {},
): AcpAgentProfile {
  return {
    id: 'legacy-profile',
    displayName: 'Legacy Profile',
    cliId: 'copilot',
    command: 'copilot --acp',
    cwd: '/workspace',
    autoRestart: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('buildLegacyCommandProfiles', () => {
  it('preserves ordinary profile identity and launch fields', () => {
    expect(
      buildLegacyCommandProfiles(
        [makeProfile()],
        'local-agentlet',
        '/server-cwd',
      ),
    ).toEqual([
      {
        id: 'legacy-profile',
        alias: 'Legacy Profile',
        agentletId: 'local-agentlet',
        command: 'copilot --acp',
        workingDirPath: '/workspace',
        metadata: { cliId: 'copilot' },
      },
    ]);
  });

  it('uses the inherited host directory when an old profile omitted cwd', () => {
    const [profile] = buildLegacyCommandProfiles(
      [makeProfile({ cwd: undefined })],
      'local-agentlet',
      '/server-cwd',
    );

    expect(profile?.workingDirPath).toBe('/server-cwd');
  });

  it('leaves legacy Agent Team and commandless records unmigrated', () => {
    expect(
      buildLegacyCommandProfiles(
        [
          makeProfile({ id: 'team', cliId: 'agent-team' }),
          makeProfile({ id: 'commandless', command: undefined }),
        ],
        'local-agentlet',
        '/server-cwd',
      ),
    ).toEqual([]);
  });
});
