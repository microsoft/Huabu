// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  };
}

function createRegistry(): AgentTeamSettingsRegistry {
  return {
    listMachines: vi.fn(() => [
      { machine: 'machine-a', hostname: 'machine-a', platform: 'linux' },
    ]),
    listMemberSummaries: vi.fn(() => []),
    getMemberDetail: vi.fn(() => {
      throw new Error('No members');
    }),
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
      url: '/api/agent-team/settings/profiles',
      payload: {
        alias: '',
        agentletId: 'machine-a',
        workingDirectory: { kind: 'custom', path: 'relative/path' },
        launch: {
          kind: 'agent-team-manifest',
          manifestPath: '/teams/reviewer/agentlet.yaml',
          harness: 'copilot',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation_failed' });
    expect(registry.createProfile).not.toHaveBeenCalled();
  });

  it('does not expose collection-root mutations', async () => {
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(
        () => createRegistry(),
        () => 'machine-a',
      ),
      { prefix: '/api/agent-team' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-team/settings/roots',
      payload: { machine: 'machine-a', path: '/teams' },
    });

    expect(response.statusCode).toBe(404);
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
        workingDirectory: {
          kind: 'custom',
          path: '/teams/reviewer/workspaces/copilot',
        },
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

  it('compiles a default workspace into a Profile-owned absolute path', async () => {
    const registry = createRegistry();
    vi.mocked(registry.getMemberDetail).mockReturnValue({
      member: {
        machine: 'machine-a',
        manifestPath: '/teams/reviewer/agentlet.yaml',
        name: 'Paper Reviewer',
        description: '',
        harnesses: ['copilot'],
        env: [],
        discoveredBy: [],
        status: 'active',
      },
      config: {
        machine: 'machine-a',
        manifestPath: '/teams/reviewer/agentlet.yaml',
        fields: [],
        missingRequired: [],
        ready: true,
      },
      profiles: [],
    });
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(
        () => registry,
        () => 'machine-a',
        () => '/huabu/agent-team/workspaces',
      ),
      { prefix: '/api/agent-team' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-team/settings/profiles',
      payload: {
        alias: 'Reviewer',
        agentletId: 'machine-a',
        workingDirectory: { kind: 'default' },
        launch: {
          kind: 'agent-team-manifest',
          manifestPath: '/teams/reviewer/agentlet.yaml',
          harness: 'copilot',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(registry.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^profile-/),
        workingDirPath: expect.stringMatching(
          /[/\\]Paper-Reviewer[/\\]copilot[/\\]profile-/,
        ),
      }),
    );
  });

  it('rejects a default workspace for a remote Agentlet', async () => {
    const registry = createRegistry();
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(
        () => registry,
        () => 'machine-a',
        () => '/huabu/agent-team/workspaces',
      ),
      { prefix: '/api/agent-team' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-team/settings/profiles',
      payload: {
        alias: 'Reviewer',
        agentletId: 'machine-b',
        workingDirectory: { kind: 'default' },
        launch: {
          kind: 'agent-team-manifest',
          manifestPath: '/teams/reviewer/agentlet.yaml',
          harness: 'copilot',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'invalid_working_directory',
    });
    expect(registry.createProfile).not.toHaveBeenCalled();
  });
});
