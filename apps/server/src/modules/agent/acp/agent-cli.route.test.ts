// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAcpAgentCliRoutes } from './agent-cli.route.js';
import { markBasicAuthenticated } from '../../security/owner.js';

import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({ getProfile: vi.fn(), discover: vi.fn() }));
vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({ getProfile: mocks.getProfile }),
  getSupervisedAgentletId: () => 'supervised',
  getAgentletGateway: () => ({ discoverHarnesses: mocks.discover }),
}));

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('ACP agent CLI route', () => {
  it('returns the complete trusted catalogue in detector order', async () => {
    const detect = vi.fn(async () => [
      {
        id: 'copilot',
        displayName: 'GitHub Copilot',
        binary: 'copilot',
        acpArgs: ['--acp'],
        autoApprove: null,
        installed: true,
        installHint: 'Install Copilot',
      },
      {
        id: 'claude',
        displayName: 'Claude Agent',
        binary: 'claude-agent-acp',
        acpArgs: [],
        autoApprove: null,
        installed: false,
        installHint: 'Install Claude Agent ACP',
      },
    ]);
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(detect), {
      prefix: '/api/acp',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/acp/agent-cli',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().agents).toEqual(await detect.mock.results[0]?.value);
    expect(response.json().agents[1]).toMatchObject({
      id: 'claude',
      installed: false,
    });
  });

  it('rejects remote callers before contacting the agentlet', async () => {
    const detect = vi.fn(async () => []);
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(detect), {
      prefix: '/api/acp',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/acp/agent-cli',
      remoteAddress: '192.0.2.10',
    });

    expect(response.statusCode).toBe(403);
    expect(detect).not.toHaveBeenCalled();
  });

  it('allows the authenticated remote owner to request agentlet detection', async () => {
    const detect = vi.fn(async () => []);
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      markBasicAuthenticated(request);
    });
    await app.register(createAcpAgentCliRoutes(detect), {
      prefix: '/api/acp',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/acp/agent-cli',
      remoteAddress: '192.0.2.10',
    });

    expect(response.statusCode).toBe(200);
    expect(detect).toHaveBeenCalledOnce();
  });

  it('returns an explicit failure instead of an empty installed catalogue', async () => {
    app = Fastify({ logger: false });
    await app.register(
      createAcpAgentCliRoutes(
        vi.fn().mockRejectedValue(new Error('agentlet offline')),
      ),
      { prefix: '/api/acp' },
    );
    const response = await app.inject('/api/acp/agent-cli');
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('harness_discovery_unavailable');
    expect(response.json()).not.toHaveProperty('agents');
  });

  it('queries the edited Profile machine and projects Custom for older catalogues', async () => {
    mocks.getProfile.mockReturnValue({ agentletId: 'remote-machine' });
    mocks.discover.mockResolvedValue({ harnesses: [] });
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(), { prefix: '/api/acp' });
    const response = await app.inject(
      '/api/acp/agent-cli?profileId=remote-profile',
    );
    expect(response.statusCode).toBe(200);
    expect(mocks.discover).toHaveBeenCalledWith('remote-machine', {
      prepareWorkspaces: false,
    });
    expect(response.json().agents).toEqual([
      expect.objectContaining({
        id: 'custom',
        capabilities: {
          customLaunchCommand: 'supported',
          autoApprove: 'unsupported',
          modelOverride: 'unsupported',
          sessionPersistence: 'unsupported',
        },
      }),
    ]);
  });

  it('rejects invalid query fields and missing Profiles without detection', async () => {
    const detect = vi.fn(async () => []);
    mocks.getProfile.mockReturnValue(undefined);
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(detect), { prefix: '/api/acp' });
    expect((await app.inject('/api/acp/agent-cli?profileId=')).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject('/api/acp/agent-cli?unexpected=value')).statusCode,
    ).toBe(400);
    expect(
      (await app.inject('/api/acp/agent-cli?profileId=missing')).statusCode,
    ).toBe(404);
    expect(detect).not.toHaveBeenCalled();
  });
});
