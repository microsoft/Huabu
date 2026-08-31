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
  },
  resourceRegistry: {
    list: vi.fn(),
  },
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getAgentTeamRegistry: () => mocks.registry,
  getResourceRegistry: () => mocks.resourceRegistry,
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
  schemaVersion: 2,
  id: 'command-1',
  alias: 'Copilot',
  agentletId: 'machine-a',
  workingDirPath: '/work/project',
  resourceIds: [],
  launch: { kind: 'acp-command' as const, command: 'copilot --acp' },
};

const manifestProfile = {
  schemaVersion: 2,
  id: 'team-1',
  alias: 'Reviewer',
  agentletId: 'machine-b',
  workingDirPath: '/teams/reviewer/workspaces/claude',
  resourceIds: [],
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
      resourceIds: [],
      metadata: { cliId: 'copilot' },
    });

    expect(response.json()).toEqual(commandProfile);
  });

  it('lists the owner-facing Agent Resource catalogue', async () => {
    const resources = [
      {
        schemaVersion: 1,
        id: 'huabu-access',
        name: 'Huabu Access',
        provider: 'huabu',
        description: 'Access the Space',
        instructions: 'Fetch $HUABU_RFS_URL/skill.',
      },
    ];
    mocks.resourceRegistry.list.mockReturnValue(resources);
    app = Fastify({ logger: false });
    await app.register(acpProfilesRoutes, { prefix: '/api/acp' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/acp/resources',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ resources });
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
