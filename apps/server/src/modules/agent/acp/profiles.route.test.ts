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
  },
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentTeamRegistry: () => mocks.registry,
  getDaemonSupervisor: () => ({
    getStatus: () => ({ online: true, restartAttempt: 0 }),
  }),
  getSupervisedAgentletId: () => 'machine-a',
}));

vi.mock('./profile-store.js', () => ({
  deleteProfile: vi.fn(),
  getProfile: vi.fn(),
  listProfiles: () => [],
}));

vi.mock('./profile-schema-cache.js', () => ({
  invalidateProfileSchemaCache: vi.fn(),
}));

const commandProfile = {
  id: 'command-1',
  alias: 'Copilot',
  agentletId: 'machine-a',
  workingDirPath: '/work/project',
  launch: { kind: 'acp-command' as const, command: 'copilot --acp' },
};

const manifestProfile = {
  id: 'team-1',
  alias: 'Reviewer',
  agentletId: 'machine-b',
  workingDirPath: '/teams/reviewer/workspaces/claude',
  launch: {
    kind: 'agent-team-manifest' as const,
    manifestPath: '/teams/reviewer/agentlet.yaml',
    harness: 'claude',
  },
  preparation: { status: 'ready' as const, completedAt: 1 },
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

describe('ACP Profile catalog routes', () => {
  it('creates command Profiles through the unified resource contract', async () => {
    mocks.registry.createProfile.mockReturnValue(commandProfile);
    app = Fastify({ logger: false });
    await app.register(acpProfilesRoutes, { prefix: '/api/acp' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/acp/profiles',
      payload: {
        alias: 'Copilot',
        workingDirPath: '/work/project',
        launch: { kind: 'acp-command', command: 'copilot --acp' },
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
    expect(response.json()).toEqual(commandProfile);
  });

  it('prevents callers from forging discovery provenance', async () => {
    mocks.registry.createProfile.mockImplementation((input) => ({
      ...commandProfile,
      customData: input.customData,
    }));
    app = Fastify({ logger: false });
    await app.register(acpProfilesRoutes, { prefix: '/api/acp' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/acp/profiles',
      payload: {
        alias: 'Copilot',
        workingDirPath: '/work/project',
        launch: { kind: 'acp-command', command: 'copilot --acp' },
        customData: {
          icon: { shape: 'circle', color: 'blue' },
          discoveredAgent: {
            version: 1,
            agentletId: 'forged-machine',
            harnessId: 'copilot',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.registry.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        customData: {
          icon: { shape: 'circle', color: 'blue' },
        },
      }),
    );
  });

  it('preserves host-owned discovery provenance when patching custom data', async () => {
    const discoveredProfile = {
      ...commandProfile,
      customData: {
        discoveredAgent: {
          version: 1,
          agentletId: 'machine-a',
          harnessId: 'copilot',
        },
      },
    };
    mocks.registry.getProfile.mockReturnValue(discoveredProfile);
    mocks.registry.patchProfile.mockImplementation((_id, patch) => ({
      ...discoveredProfile,
      ...patch,
    }));
    app = Fastify({ logger: false });
    await app.register(acpProfilesRoutes, { prefix: '/api/acp' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/acp/profiles/command-1',
      payload: {
        customData: {
          icon: { shape: 'diamond', color: 'green' },
          discoveredAgent: {
            version: 1,
            agentletId: 'forged-machine',
            harnessId: 'claude',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.registry.patchProfile).toHaveBeenCalledWith('command-1', {
      customData: {
        icon: { shape: 'diamond', color: 'green' },
        discoveredAgent: {
          version: 1,
          agentletId: 'machine-a',
          harnessId: 'copilot',
        },
      },
    });
  });

  it('lists every Profile but selects only runtime-ready resources', async () => {
    mocks.registry.listProfiles.mockReturnValue([
      commandProfile,
      manifestProfile,
    ]);
    mocks.registry.listSelectableProfileIds.mockReturnValue([
      commandProfile.id,
      manifestProfile.id,
    ]);
    app = Fastify({ logger: false });
    await app.register(acpProfilesRoutes, { prefix: '/api/acp' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/acp/profiles',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profiles: [commandProfile, manifestProfile],
      selectableProfileIds: ['command-1', 'team-1'],
    });
  });

  it('keeps a manifest Profile out of selectors when Configs are incomplete', async () => {
    mocks.registry.listProfiles.mockReturnValue([manifestProfile]);
    mocks.registry.listSelectableProfileIds.mockReturnValue([]);
    app = Fastify({ logger: false });
    await app.register(acpProfilesRoutes, { prefix: '/api/acp' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/acp/profiles',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().selectableProfileIds).toEqual([]);
  });
});
