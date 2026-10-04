// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AgentProfileError } from '@agenetes/agent-profile';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import acpProfilesRoutes from './profiles.route.js';

const mocks = vi.hoisted(() => ({
  registry: {
    listProfiles: vi.fn(),
    listSelectableProfileIds: vi.fn(),
    createProfile: vi.fn(),
    getProfile: vi.fn(),
    patchProfile: vi.fn(),
    deleteProfile: vi.fn(),
  },
  invalidate: vi.fn(),
  initializeDefaults: vi.fn(),
  discoverHarnesses: vi.fn(),
  buildHarnessLaunch: vi.fn(),
  connectedIds: new Set(['machine-a', 'remote-machine']),
}));

vi.mock('../agent-defaults.js', () => ({
  getAgentDefaults: () => ({ profileId: null, functionalModel: '' }),
  initializeAgentDefaults: mocks.initializeDefaults,
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => mocks.registry,
  getDaemonSupervisor: () => ({
    getStatus: () => ({ online: true, restartAttempt: 0 }),
  }),
  getAgentletGateway: () => ({
    discoverHarnesses: mocks.discoverHarnesses,
    buildHarnessLaunch: mocks.buildHarnessLaunch,
    getAgentlets: () =>
      [...mocks.connectedIds].map((agentletId) => ({
        agentletId,
        status: 'connected',
        connectedAt: new Date('2026-01-01T00:00:00.000Z'),
        agentletProfile: {
          bridge: { name: 'agentlet', version: '1.0.0' },
          machine: {
            hostname: `${agentletId}-host`,
            platform: 'linux',
            arch: 'x64',
          },
        },
      })),
  }),
  resolveConnectedAgentletId: (target: string) => {
    if (mocks.connectedIds.has(target)) return target;
    const matches = [...mocks.connectedIds].filter(
      (agentletId) => `${agentletId}-host` === target,
    );
    return matches.length === 1 ? matches[0] : undefined;
  },
}));

vi.mock('./profile-schema-cache.js', () => ({
  invalidateProfileSchemaCache: mocks.invalidate,
}));

const commandProfile = {
  id: 'command-1',
  alias: 'Copilot',
  agentletId: 'machine-a',
  workingDirPath: '/work/project',
  launch: { kind: 'acp-command' as const, command: 'copilot --acp' },
};
const source = { version: 1, agentletId: 'machine-a', harnessId: 'copilot' };

let app: FastifyInstance | undefined;
async function setup() {
  app = Fastify({ logger: false });
  await app.register(acpProfilesRoutes, { prefix: '/api/acp' });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.resetAllMocks();
});

describe('ordinary Profile catalog routes', () => {
  it('validates typed harness launch on the target daemon and preserves structured options', async () => {
    const launch = {
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: true },
    };
    mocks.discoverHarnesses.mockResolvedValue({
      harnesses: [
        {
          id: 'copilot',
          installed: true,
          launchVersion: 1,
          launchPreviewVersion: 1,
          capabilities: {
            autoApprove: 'supported',
            customLaunchCommand: 'unsupported',
          },
          autoApprove: { args: ['--allow-all'], position: 'after-acp' },
        },
      ],
    });
    mocks.registry.createProfile.mockReturnValue({ ...commandProfile, launch });
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profiles',
      payload: {
        alias: 'Typed',
        agentletId: 'machine-a',
        workingDirPath: '/work',
        launch,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.discoverHarnesses).toHaveBeenCalledWith('machine-a', {
      prepareWorkspaces: false,
    });
    expect(mocks.registry.createProfile).toHaveBeenCalledWith({
      alias: 'Typed',
      agentletId: 'machine-a',
      workingDirPath: '/work',
      launchKind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: true },
    });
  });

  it.each([
    { harnesses: [] },
    { harnesses: [{ id: 'copilot', installed: true }] },
    { harnesses: [{ id: 'copilot', installed: false, launchVersion: 1 }] },
  ])(
    'rejects unavailable structured launches without command fallback: %j',
    async (discovery) => {
      mocks.discoverHarnesses.mockResolvedValue(discovery);
      const server = await setup();
      const response = await server.inject({
        method: 'POST',
        url: '/api/acp/profiles',
        payload: {
          alias: 'Typed',
          agentletId: 'machine-a',
          workingDirPath: '/work',
          launch: { kind: 'acp-harness', harnessId: 'copilot' },
        },
      });
      expect(response.statusCode).toBe(409);
      expect(mocks.registry.createProfile).not.toHaveBeenCalled();
    },
  );

  it('creates manual command Profiles without an automatic source', async () => {
    mocks.registry.createProfile.mockReturnValue(commandProfile);
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profiles',
      payload: {
        alias: 'Copilot',
        agentletId: 'machine-a',
        workingDirPath: '/work/project',
        launch: commandProfile.launch,
        metadata: { cliId: 'copilot' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.registry.createProfile).toHaveBeenCalledWith({
      launchKind: 'acp-command',
      alias: 'Copilot',
      agentletId: 'machine-a',
      command: 'copilot --acp',
      workingDirPath: '/work/project',
      metadata: { cliId: 'copilot' },
    });
  });

  it('lists ordinary persisted Profiles without materializing anything', async () => {
    mocks.registry.listProfiles.mockReturnValue([commandProfile]);
    mocks.registry.listSelectableProfileIds.mockReturnValue([
      commandProfile.id,
    ]);
    const server = await setup();
    const response = await server.inject('/api/acp/profiles');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profiles: [commandProfile],
      selectableProfileIds: ['command-1'],
      connectedDevices: [
        expect.objectContaining({
          agentletId: 'machine-a',
          profileCount: 1,
        }),
        expect.objectContaining({
          agentletId: 'remote-machine',
          profileCount: 0,
        }),
      ],
    });

    expect(mocks.registry.createProfile).not.toHaveBeenCalled();
    expect(mocks.initializeDefaults).not.toHaveBeenCalled();
    expect(mocks.discoverHarnesses).not.toHaveBeenCalled();
  });

  it('maps one hostname-era Profile to the unique connected device', async () => {
    const legacyProfile = {
      ...commandProfile,
      id: 'legacy-command',
      agentletId: 'machine-a-host',
    };
    mocks.registry.listProfiles.mockReturnValue([legacyProfile]);
    const server = await setup();
    const response = await server.inject('/api/acp/profiles');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profiles: [legacyProfile],
      selectableProfileIds: ['legacy-command'],
      connectedDevices: [
        expect.objectContaining({
          agentletId: 'machine-a',
          profileCount: 1,
        }),
        expect.objectContaining({
          agentletId: 'remote-machine',
          profileCount: 0,
        }),
      ],
    });
  });

  it('rejects caller-created automatic provenance', async () => {
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profiles',
      payload: {
        alias: 'Forged',
        agentletId: 'machine-a',
        workingDirPath: '/work',
        launch: commandProfile.launch,
        customData: { discoveredAgent: source },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.registry.createProfile).not.toHaveBeenCalled();
  });

  it.each([null, { label: 'my preference' }, { discoveredAgent: source }])(
    'preserves automatic provenance when replacing customData: %j',
    async (customData) => {
      mocks.registry.getProfile.mockReturnValue({
        ...commandProfile,
        customData: { discoveredAgent: source },
      });
      mocks.registry.patchProfile.mockReturnValue(commandProfile);
      const server = await setup();
      const response = await server.inject({
        method: 'PATCH',
        url: '/api/acp/profiles/command-1',
        payload: { expectedRevision: 0, customData },
      });
      expect(response.statusCode).toBe(200);
      expect(mocks.registry.patchProfile).toHaveBeenCalledWith('command-1', {
        expectedRevision: 0,
        customData: { ...customData, discoveredAgent: source },
      });
    },
  );

  it('rejects changing a source to another machine or harness', async () => {
    mocks.registry.getProfile.mockReturnValue({
      ...commandProfile,
      customData: { discoveredAgent: source },
    });
    const server = await setup();
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/acp/profiles/command-1',
      payload: {
        expectedRevision: 0,
        customData: { discoveredAgent: { ...source, harnessId: 'claude' } },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.registry.patchProfile).not.toHaveBeenCalled();
  });

  it('uses ordinary deletion and invalidates only the Profile cache', async () => {
    mocks.registry.deleteProfile.mockReturnValue(true);
    const server = await setup();
    const response = await server.inject({
      method: 'DELETE',
      url: '/api/acp/profiles/command-1',
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.registry.deleteProfile).toHaveBeenCalledWith('command-1');
    expect(mocks.invalidate).toHaveBeenCalledWith('command-1');
  });

  it('edits a Custom template in place without parsing a known-harness metadata label', async () => {
    mocks.registry.getProfile.mockReturnValue({
      ...commandProfile,
      revision: 3,
      customData: { discoveredAgent: source },
      metadata: { cliId: 'copilot' },
    });
    mocks.registry.patchProfile.mockReturnValue({
      ...commandProfile,
      revision: 4,
      executionRevision: 1,
    });
    const server = await setup();
    const launch = {
      kind: 'acp-command',
      command: 'copilot --acp --allow-all',
    };
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/acp/profiles/command-1',
      payload: { expectedRevision: 3, launch, workingDirPath: '/new/work' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.registry.patchProfile).toHaveBeenCalledWith('command-1', {
      expectedRevision: 3,
      launch,
      workingDirPath: '/new/work',
    });
    expect(mocks.discoverHarnesses).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledWith('command-1');
  });

  it('validates structured edits against the saved machine and rechecks the revision at commit', async () => {
    const launch = {
      kind: 'acp-harness',
      harnessId: 'copilot',
      options: { autoApprove: true },
    };
    mocks.registry.getProfile.mockReturnValue({
      ...commandProfile,
      agentletId: 'remote-machine',
      revision: 2,
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
    });
    mocks.discoverHarnesses.mockResolvedValue({
      harnesses: [
        {
          id: 'copilot',
          installed: true,
          launchVersion: 1,
          launchPreviewVersion: 1,
          capabilities: { autoApprove: 'supported' },
        },
      ],
    });
    mocks.registry.patchProfile.mockReturnValue({
      ...commandProfile,
      launch,
      revision: 3,
    });
    const server = await setup();
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/acp/profiles/command-1',
      payload: { expectedRevision: 2, launch },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.buildHarnessLaunch).toHaveBeenCalledWith('remote-machine', {
      launch,
    });
    expect(mocks.registry.patchProfile).toHaveBeenCalledWith('command-1', {
      expectedRevision: 2,
      launch,
    });
  });

  it('rejects stale saves before validation and never writes', async () => {
    mocks.registry.getProfile.mockReturnValue({
      ...commandProfile,
      revision: 2,
    });
    const server = await setup();
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/acp/profiles/command-1',
      payload: { expectedRevision: 1, alias: 'stale' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('profile_conflict');
    expect(mocks.registry.patchProfile).not.toHaveBeenCalled();
    expect(mocks.discoverHarnesses).not.toHaveBeenCalled();
  });

  it('returns conflict when the registry revision changes during asynchronous validation', async () => {
    mocks.registry.getProfile.mockReturnValue({
      ...commandProfile,
      revision: 1,
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
    });
    mocks.discoverHarnesses.mockResolvedValue({
      harnesses: [
        {
          id: 'copilot',
          installed: true,
          launchVersion: 1,
          launchPreviewVersion: 1,
          capabilities: { autoApprove: 'supported' },
        },
      ],
    });
    mocks.buildHarnessLaunch.mockImplementation(async () => {
      mocks.registry.patchProfile.mockImplementation(() => {
        throw new AgentProfileError(
          'profile_conflict',
          'Profile changed during validation',
        );
      });
      return {
        kind: 'exec',
        executable: '/bin/copilot',
        argv: ['--acp'],
        env: {},
      };
    });
    const server = await setup();
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/acp/profiles/command-1',
      payload: { expectedRevision: 1, workingDirPath: '/new/work' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('profile_conflict');
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('rejects changing the wrapper through an edit', async () => {
    mocks.registry.getProfile.mockReturnValue(commandProfile);
    const server = await setup();
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/acp/profiles/command-1',
      payload: {
        expectedRevision: 0,
        launch: { kind: 'acp-harness', harnessId: 'copilot' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('profile_wrapper_immutable');
    expect(mocks.registry.patchProfile).not.toHaveBeenCalled();
  });

  it('previews on the Profile machine without creating or mutating a Profile', async () => {
    mocks.registry.getProfile.mockReturnValue({
      ...commandProfile,
      agentletId: 'remote-machine',
    });
    const plan = { kind: 'shell', command: commandProfile.launch.command };
    mocks.buildHarnessLaunch.mockResolvedValue(plan);
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profile-launch-preview',
      payload: { profileId: commandProfile.id, launch: commandProfile.launch },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(plan);
    expect(mocks.buildHarnessLaunch).toHaveBeenCalledWith('remote-machine', {
      launch: commandProfile.launch,
    });
    expect(mocks.registry.createProfile).not.toHaveBeenCalled();
    expect(mocks.registry.patchProfile).not.toHaveBeenCalled();
  });

  it('reports unavailable preview instead of a fabricated command', async () => {
    mocks.buildHarnessLaunch.mockRejectedValue(new Error('unsupported'));
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profile-launch-preview',
      payload: {
        agentletId: 'machine-a',
        launch: commandProfile.launch,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('harness_preview_unavailable');
  });
});
