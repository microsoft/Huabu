// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profile: undefined as
    | {
        id: string;
        alias: string;
        agentletId: string;
        workingDirPath: string;
        resourceIds: string[];
        launch:
          | { kind: 'acp-command'; command: string }
          | {
              kind: 'agent-team-manifest';
              manifestPath: string;
              harness: string;
            };
      }
    | undefined,
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentTeamRegistry: () => ({
    getProfile: () => mocks.profile,
  }),
  getResourceRegistry: () => ({
    get: (id: string) => ({
      schemaVersion: 1,
      id,
      name: id,
      provider: 'huabu',
      description: id,
      instructions: id,
    }),
  }),
  getSupervisedAgentletId: () => 'supervised-agentlet',
}));

vi.mock('../agenetes/drivers.js', () => ({
  agenetes: {},
  EXTERNAL_DRIVER_KIND: 'acp',
}));

vi.mock('../../../prompt/external-agent/system-preamble.js', () => ({
  DEFAULT_HUABU_RESOURCE_IDS: ['huabu-access', 'local-resource-management'],
  renderExternalAgentSystemPreamble: () => 'Mandatory preamble',
}));

vi.mock('./reachback-env.js', () => ({
  buildReachbackEnv: () => ({ REACHBACK: '1' }),
}));

vi.mock('../../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => `/canvases/${canvasId}/acp`,
}));

import { buildAcpWorkloadSpec } from './service.js';

describe('buildAcpWorkloadSpec', () => {
  beforeEach(() => {
    mocks.profile = undefined;
  });

  it('applies cwd and preamble overrides to command profiles', () => {
    mocks.profile = {
      id: 'profile-a',
      alias: 'Researcher',
      agentletId: 'agentlet-a',
      workingDirPath: '/profile/work',
      resourceIds: ['web-search'],
      launch: { kind: 'acp-command', command: 'copilot --acp' },
    };

    const workload = buildAcpWorkloadSpec({
      binding: {
        profileId: 'profile-a',
        alias: 'Researcher',
      },
      threadId: 'thread-a',
      canvasId: 'canvas-a',
      launchOverrides: {
        workingDirPath: '/task/work',
        additionalInitialPreamble: 'Task-specific constraints',
      },
    });

    expect(workload.spec).toMatchObject({
      cwd: '/task/work',
      resourceIds: ['huabu-access', 'local-resource-management', 'web-search'],
      initialPreamble: ['Mandatory preamble', 'Task-specific constraints'],
      recipe: {
        command: 'copilot --acp',
        cwd: '/task/work',
      },
    });
  });

  it('updates both workload and manifest working directories', () => {
    mocks.profile = {
      id: 'profile-a',
      alias: 'Reviewer',
      agentletId: 'agentlet-a',
      workingDirPath: '/profile/work',
      resourceIds: [],
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: '/team/agentlet.yaml',
        harness: 'claude',
      },
    };

    const workload = buildAcpWorkloadSpec({
      binding: {
        profileId: 'profile-a',
        alias: 'Reviewer',
      },
      threadId: 'thread-a',
      canvasId: 'canvas-a',
      launchOverrides: { workingDirPath: '/task/work' },
    });

    expect(workload.spec).toMatchObject({
      cwd: '/task/work',
      recipe: {
        agentTeam: {
          manifestPath: '/team/agentlet.yaml',
          workingDirPath: '/task/work',
          harness: 'claude',
        },
      },
    });
  });
});
