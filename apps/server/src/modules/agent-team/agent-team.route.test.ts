import { AgentTeamError } from '@agenetes/agentlet-host';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentTeamRoutes,
  type AgentTeamSettingsRegistry,
} from './agent-team.route.js';

import type { FastifyInstance } from 'fastify';

function profile() {
  return {
    id: 'profile-1',
    alias: 'Reviewer',
    agentletId: 'machine-a',
    workingDirPath: '/teams/reviewer/workspaces/copilot',
    launch: {
      kind: 'agent-team-manifest' as const,
      manifestPath: '/teams/reviewer/agentlet.yaml',
      harness: 'copilot',
    },
    preparation: { status: 'not_prepared' as const },
    setupLog: [],
  };
}

function createRegistry(): AgentTeamSettingsRegistry {
  return {
    listMachines: vi.fn(() => [
      { machine: 'machine-a', hostname: 'machine-a', platform: 'linux' },
    ]),
    listRoots: vi.fn(() => []),
    listMemberSummaries: vi.fn(() => []),
    getMemberDetail: vi.fn(() => {
      throw new Error('No members');
    }),
    addRoot: vi.fn(async (root) => ({
      ok: true as const,
      root: {
        ...root,
        scan: { status: 'success' as const, scannedAt: 1, diagnostics: [] },
      },
      members: [],
    })),
    rescanRoot: vi.fn(async (root) => ({
      ok: true as const,
      root: {
        ...root,
        scan: { status: 'success' as const, scannedAt: 1, diagnostics: [] },
      },
      members: [],
    })),
    removeRoot: vi.fn(() => true),
    updateMemberConfigs: vi.fn(async (machine, manifestPath) => ({
      machine,
      manifestPath,
      fields: [],
      missingRequired: [],
      ready: true,
    })),
    createProfile: vi.fn(() => profile()),
    patchProfile: vi.fn(() => profile()),
    deleteProfile: vi.fn(() => true),
    setupProfile: vi.fn(async () => profile()),
    cancelProfileSetup: vi.fn(async () => profile()),
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('Agent Team Settings routes', () => {
  it('returns a redacted Settings snapshot to loopback callers', async () => {
    const registry = createRegistry();
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(
        () => registry,
        () => 'machine-a',
      ),
      {
        prefix: '/api/agent-team',
      },
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/agent-team/settings',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      machines: [
        { machine: 'machine-a', hostname: 'machine-a', platform: 'linux' },
      ],
      localMachine: 'machine-a',
      roots: [],
      members: [],
    });
  });

  it('rejects remote Settings callers before reading the registry', async () => {
    const getRegistry = vi.fn(() => createRegistry());
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(getRegistry, () => 'machine-a'),
      {
        prefix: '/api/agent-team',
      },
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/agent-team/settings',
      remoteAddress: '192.0.2.10',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'loopback_required' });
    expect(getRegistry).not.toHaveBeenCalled();
  });

  it('validates mutation bodies before invoking the control plane', async () => {
    const registry = createRegistry();
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(
        () => registry,
        () => 'machine-a',
      ),
      {
        prefix: '/api/agent-team',
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-team/settings/roots',
      payload: { machine: ' machine-a ', path: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation_failed' });
    expect(registry.addRoot).not.toHaveBeenCalled();
  });

  it('maps expected domain conflicts without hiding infrastructure errors', async () => {
    const registry = createRegistry();
    vi.mocked(registry.createProfile).mockImplementationOnce(() => {
      throw new AgentTeamError('profile_conflict', 'Profile already exists');
    });
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(
        () => registry,
        () => 'machine-a',
      ),
      {
        prefix: '/api/agent-team',
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-team/settings/profiles',
      payload: {
        alias: 'Reviewer',
        agentletId: 'machine-a',
        workingDirPath: '/teams/reviewer/workspaces/copilot',
        launch: {
          kind: 'agent-team-manifest',
          manifestPath: '/teams/reviewer/agentlet.yaml',
          harness: 'copilot',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      message: 'Profile already exists',
      code: 'profile_conflict',
    });
  });

});
