// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  getSupervisedAgentletId: () => 'machine-a',
  getAgentletGateway: () => ({ discoverHarnesses: mocks.discoverHarnesses }),
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
          autoApprove: { args: ['--allow-all'], position: 'after-acp' },
        },
      ],
    });
    mocks.registry.createProfile.mockReturnValue({ ...commandProfile, launch });
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profiles',
      payload: { alias: 'Typed', workingDirPath: '/work', launch },
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
    });
    expect(mocks.registry.createProfile).not.toHaveBeenCalled();
    expect(mocks.initializeDefaults).not.toHaveBeenCalled();
    expect(mocks.discoverHarnesses).not.toHaveBeenCalled();
  });

  it('rejects caller-created automatic provenance', async () => {
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/profiles',
      payload: {
        alias: 'Forged',
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
        payload: { customData },
      });
      expect(response.statusCode).toBe(200);
      expect(mocks.registry.patchProfile).toHaveBeenCalledWith('command-1', {
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
});
