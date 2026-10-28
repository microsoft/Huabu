// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AgentProfileError } from '@agenetes/agent-profile';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import acpProfilesRoutes from './profiles.route.js';

import type * as ProfileCapabilities from './profile-capabilities.js';

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
  readCapabilities: vi.fn(),
  discoverCapabilities: vi.fn(),
  connectedIds: new Set(['machine-a', 'remote-machine']),
  pickerDeviceId: vi.fn(),
}));

vi.mock('./picker-device.js', () => ({
  readPickerDeviceId: mocks.pickerDeviceId,
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
vi.mock('./profile-capabilities.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileCapabilities>()),
  readProfileCapabilities: mocks.readCapabilities,
  discoverProfileCapabilities: mocks.discoverCapabilities,
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
  it('hides the proxy from normal catalogues without hiding its connected device', async () => {
    mocks.registry.listProfiles.mockReturnValue([
      commandProfile,
      { ...commandProfile, id: 'hidden', visible: false },
    ]);
    const server = await setup();
    const response = await server.inject({
      method: 'GET',
      url: '/api/acp/profiles',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().profiles).toEqual([commandProfile]);
    expect(response.json().selectableProfileIds).not.toContain('hidden');
    expect(response.json().connectedDevices).toContainEqual(
      expect.objectContaining({ agentletId: 'machine-a', profileCount: 1 }),
    );
  });
  it('reserves the bundled proxy harness for automatic hidden provisioning', async () => {
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profiles',
      payload: {
        alias: 'Proxy',
        agentletId: 'machine-a',
        workingDirPath: '/work',
        launch: { kind: 'acp-harness', harnessId: 'proxy' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.registry.createProfile).not.toHaveBeenCalled();
  });
  it.each([
    ['machine-a', 'machine-a'],
    ['remote-machine-host', null],
    ['disconnected', null],
    [null, null],
  ])(
    'only exposes a connected exact local picker identity: %s',
    async (localId, expected) => {
      mocks.registry.listProfiles.mockReturnValue([]);
      mocks.pickerDeviceId.mockResolvedValue(localId);
      const server = await setup();
      const response = await server.inject({
        method: 'GET',
        url: '/api/acp/profiles',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().folderPickerAgentletId).toBe(expected);
    },
  );

  it('disables folder picking when local identity cannot be read without hiding Profiles', async () => {
    mocks.registry.listProfiles.mockReturnValue([commandProfile]);
    mocks.pickerDeviceId.mockRejectedValue(new Error('Invalid identity'));
    const server = await setup();
    const response = await server.inject({
      method: 'GET',
      url: '/api/acp/profiles',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profiles: [commandProfile],
      folderPickerAgentletId: null,
    });
  });
  it.each([
    ['GET', '/capabilities', 'readCapabilities'],
    ['POST', '/capabilities/discover', 'discoverCapabilities'],
  ] as const)(
    'routes %s Profile capabilities without a user thread',
    async (method, suffix, operation) => {
      mocks[operation].mockResolvedValue({ source: 'profile' });
      const server = await setup();
      const response = await server.inject({
        method,
        url: `/api/acp/profiles/command-1${suffix}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ source: 'profile' });
      expect(mocks[operation].mock.calls[0][0]).toBe('command-1');
      expect(mocks.registry.createProfile).not.toHaveBeenCalled();
    },
  );

  it.each(['GET', 'POST'] as const)(
    'keeps %s capability operations owner-only',
    async (method) => {
      const server = await setup();
      const response = await server.inject({
        method,
        url: `/api/acp/profiles/command-1/capabilities${method === 'POST' ? '/discover' : ''}`,
        remoteAddress: '203.0.113.5',
      });
      expect(response.statusCode).toBe(403);
      expect(mocks.readCapabilities).not.toHaveBeenCalled();
      expect(mocks.discoverCapabilities).not.toHaveBeenCalled();
    },
  );

  it('surfaces capability discovery errors', async () => {
    mocks.discoverCapabilities.mockRejectedValue(new Error('Login required'));
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profiles/command-1/capabilities/discover',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: 'capability_discovery_failed',
      message: 'Login required',
    });
  });
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
          status: 'ready',
          capabilities: {
            autoApprove: true,
            customLaunchCommand: false,
          },
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
          displayName: 'machine-a-host: linux x64',
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
          status: 'ready',
          capabilities: {
            autoApprove: true,
            customLaunchCommand: false,
          },
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
          status: 'ready',
          capabilities: {
            autoApprove: true,
            customLaunchCommand: false,
          },
        },
      ],
    });
    mocks.registry.patchProfile.mockImplementation(() => {
      throw new AgentProfileError(
        'profile_conflict',
        'Profile changed during validation',
      );
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
});
