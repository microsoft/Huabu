// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profile: undefined as
    | {
        id: string;
        alias: string;
        agentletId: string;
        executionRevision?: number;
        workingDirPath: string;
        launch:
          | { kind: 'acp-command'; command: string }
          | { kind: 'acp-harness'; harnessId: string };
        customData?: Record<string, unknown>;
      }
    | undefined,
  observation: null as Record<string, unknown> | null,
}));

vi.mock('./profile-schema-cache.js', () => ({
  getProfileSchemaCache: () => mocks.observation,
  mergeProfileSchemaCache: vi.fn(),
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({
    getProfile: () => mocks.profile,
  }),
}));

vi.mock('../agenetes/drivers.js', () => ({
  agenetes: {},
  EXTERNAL_DRIVER_KIND: 'acp',
}));

vi.mock('../../../prompt/external-agent/system-preamble.js', () => ({
  renderExternalAgentSystemPreamble: () => 'Mandatory preamble',
}));

vi.mock('../../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => `/canvases/${canvasId}/acp`,
}));

import { buildAcpWorkloadSpec } from './service.js';

describe('buildAcpWorkloadSpec', () => {
  beforeEach(() => {
    mocks.profile = undefined;
    mocks.observation = null;
  });

  describe('initial selections of a new conversation', () => {
    const observation = {
      metaUpdatedAt: 1,
      configOptions: [
        {
          id: 'model_id',
          category: 'model',
          options: [{ value: 'opus' }, { value: 'sonnet' }],
        },
        {
          id: 'effort',
          category: 'thought_level',
          options: [{ value: 'low' }, { value: 'high' }],
        },
      ],
    };
    const build = async (
      initialPreferences?: Parameters<
        typeof buildAcpWorkloadSpec
      >[0]['initialPreferences'],
    ) =>
      (
        await buildAcpWorkloadSpec({
          binding: { profileId: 'profile-a', alias: 'Claude' },
          threadId: 'thread-a',
          canvasId: 'canvas-a',
          ...(initialPreferences && { initialPreferences }),
        })
      ).spec;

    beforeEach(() => {
      mocks.profile = {
        id: 'profile-a',
        alias: 'Claude',
        agentletId: 'agentlet-a',
        workingDirPath: '/work',
        launch: { kind: 'acp-harness', harnessId: 'claude' },
        customData: { sessionPreferences: { model: 'sonnet' } },
      };
    });

    it('starts on what the conversation displayed, not what the Profile remembers now', async () => {
      mocks.observation = observation;

      expect(
        await build({ model: 'opus', thoughtLevel: 'high' }),
      ).toMatchObject({
        initialPreferences: { model: 'opus', thoughtLevel: 'high' },
        initialSelections: { model_id: 'opus', effort: 'high' },
      });
    });

    it('falls back to the remembered preferences for callers with no interface', async () => {
      mocks.observation = observation;

      expect(await build()).toMatchObject({
        initialPreferences: { model: 'sonnet' },
        initialSelections: { model_id: 'sonnet' },
      });
    });

    it('leaves matching to the session when the Profile has no observed catalogue', async () => {
      const spec = await build({ model: 'opus' });

      expect(spec.initialPreferences).toEqual({ model: 'opus' });
      expect(spec).not.toHaveProperty('initialSelections');
    });
  });

  it.each(['node', 'chat'])(
    'applies cwd overrides to command profiles from %s',
    async (source) => {
      mocks.profile = {
        id: 'profile-a',
        alias: 'Researcher',
        agentletId: 'agentlet-a',
        executionRevision: 4,
        workingDirPath: '/profile/work',
        launch: { kind: 'acp-command', command: 'copilot --acp' },
      };

      const workload = await buildAcpWorkloadSpec({
        binding: {
          profileId: 'profile-a',
          alias: 'Researcher',
        },
        threadId: 'thread-a',
        canvasId: 'canvas-a',
        ...(source === 'node'
          ? { launchOverrides: { workingDirPath: '/task/work' } }
          : { cwd: '/task/work' }),
      });

      expect(workload.spec).toMatchObject({
        profileExecutionRevision: 4,
        cwd: '/task/work',
        workingDirectoryOverride: '/task/work',
        initialPreamble: ['Mandatory preamble'],
        recipe: {
          command: 'copilot --acp',
          cwd: '/task/work',
        },
      });
    },
  );

  it('uses the discovered Profile machine and default workspace without overrides', async () => {
    mocks.profile = {
      id: 'profile-a',
      alias: 'Claude',
      agentletId: 'agentlet-a',
      workingDirPath: '/home/user/.agentlet/workspace/claude',
      launch: {
        kind: 'acp-command',
        command: 'claude-agent-acp',
      },
    };

    const workload = await buildAcpWorkloadSpec({
      binding: {
        profileId: 'profile-a',
        alias: 'Claude',
      },
      threadId: 'thread-a',
      canvasId: 'canvas-a',
    });
    expect(workload.spec).not.toHaveProperty('env');

    expect(workload.spec).toMatchObject({
      agentletId: 'agentlet-a',
      cwd: '/home/user/.agentlet/workspace/claude',
      workingDirectoryOverride: null,
      recipe: {
        command: 'claude-agent-acp',
        cwd: '/home/user/.agentlet/workspace/claude',
      },
    });
  });

  it('places Space instructions between bootstrap and node constraints', async () => {
    mocks.profile = {
      id: 'profile-a',
      alias: 'Researcher',
      agentletId: 'agentlet-a',
      workingDirPath: '/profile/work',
      launch: { kind: 'acp-command', command: 'copilot --acp' },
    };

    const workload = await buildAcpWorkloadSpec({
      binding: { profileId: 'profile-a', alias: 'Researcher' },
      threadId: 'thread-a',
      canvasId: 'canvas-a',
      spacePrompt: '<space_prompt>Space rules</space_prompt>',
      launchOverrides: {
        additionalInitialPreamble: 'Node constraints',
      },
    });

    expect(workload.spec.initialPreamble).toEqual([
      'Mandatory preamble',
      '<space_prompt>Space rules</space_prompt>',
      'Node constraints',
    ]);
  });

  it('rejects a missing Profile instead of inventing a placement', async () => {
    await expect(
      buildAcpWorkloadSpec({
        binding: { profileId: 'missing', alias: 'Missing' },
        threadId: 'thread-a',
        canvasId: 'canvas-a',
      }),
    ).rejects.toThrow("Agent Profile 'missing' is unavailable.");
  });
});
