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
