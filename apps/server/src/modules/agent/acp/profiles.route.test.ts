import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import acpProfilesRoutes from './profiles.route.js';

const mocks = vi.hoisted(() => ({
  registry: {
    listProfiles: vi.fn(),
    listMemberSummaries: vi.fn(),
    getMemberDetail: vi.fn(),
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
  setupLog: [],
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
    mocks.registry.listMemberSummaries.mockReturnValue([
      {
        machine: 'machine-b',
        manifestPath: manifestProfile.launch.manifestPath,
        name: 'reviewer',
        description: '',
        status: 'active',
        profileCount: 1,
        preparationCounts: {
          not_prepared: 0,
          setting_up: 0,
          ready: 1,
          error: 0,
        },
      },
    ]);
    mocks.registry.getMemberDetail.mockReturnValue({
      member: { status: 'active' },
      config: { ready: true },
      profiles: [manifestProfile],
    });
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
      legacyProfiles: [],
    });
  });

  it('keeps a manifest Profile out of selectors when Configs are incomplete', async () => {
    mocks.registry.listProfiles.mockReturnValue([manifestProfile]);
    mocks.registry.listMemberSummaries.mockReturnValue([
      {
        machine: 'machine-b',
        manifestPath: manifestProfile.launch.manifestPath,
        status: 'active',
      },
    ]);
    mocks.registry.getMemberDetail.mockReturnValue({
      config: { ready: false },
    });
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
