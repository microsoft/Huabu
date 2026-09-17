// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAcpAgentCliRoutes } from './agent-cli.route.js';
import { AcpMachineDiscoveryError } from './machine-discovery.js';
import { markBasicAuthenticated } from '../../security/owner.js';

import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('ACP agent CLI route', () => {
  it('returns cached machine observations without refreshing', async () => {
    const service = {
      list: vi.fn(() => ({
        machines: [
          {
            agentletId: 'machine-1',
            hostname: 'devbox',
            platform: 'linux',
            connected: true,
            discovery: 'ready',
            agents: [],
          },
        ],
      })),
      refresh: vi.fn(),
      materialize: vi.fn(),
      validateWorkingDirectory: vi.fn(),
    };
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(service as never), {
      prefix: '/api/acp',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/acp/agent-cli',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().machines[0]).toMatchObject({
      agentletId: 'machine-1',
      discovery: 'ready',
    });
    expect(service.list).toHaveBeenCalledOnce();
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it('rejects remote callers before reading discovery state', async () => {
    const service = {
      list: vi.fn(() => ({ machines: [] })),
    };
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(service as never), {
      prefix: '/api/acp',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/acp/agent-cli',
      remoteAddress: '192.0.2.10',
    });

    expect(response.statusCode).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('allows the authenticated remote owner to refresh a target machine', async () => {
    const service = {
      refresh: vi.fn(async () => ({ machines: [] })),
    };
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      markBasicAuthenticated(request);
    });
    await app.register(createAcpAgentCliRoutes(service as never), {
      prefix: '/api/acp',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/acp/agent-cli/refresh',
      remoteAddress: '192.0.2.10',
      payload: { agentletId: 'machine-2' },
    });

    expect(response.statusCode).toBe(200);
    expect(service.refresh).toHaveBeenCalledWith('machine-2');
  });

  it('validates materialization and path-validation inputs', async () => {
    const service = {
      materialize: vi.fn(),
      validateWorkingDirectory: vi.fn(),
    };
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(service as never), {
      prefix: '/api/acp',
    });

    const materialize = await app.inject({
      method: 'POST',
      url: '/api/acp/agent-cli/materialize',
      payload: { agentletId: '', harnessId: 'copilot' },
    });
    const validate = await app.inject({
      method: 'POST',
      url: '/api/acp/working-directory/validate',
      payload: { workingDirPath: '/work' },
    });

    expect(materialize.statusCode).toBe(400);
    expect(validate.statusCode).toBe(400);
    expect(service.materialize).not.toHaveBeenCalled();
    expect(service.validateWorkingDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/acp/agent-cli/refresh', {}],
    [
      '/api/acp/agent-cli/materialize',
      { agentletId: 'machine-1', harnessId: 'copilot' },
    ],
    [
      '/api/acp/working-directory/validate',
      { agentletId: 'machine-1', workingDirPath: '/work' },
    ],
  ])('rejects non-owner POST %s', async (url, payload) => {
    const service = {
      refresh: vi.fn(),
      materialize: vi.fn(),
      validateWorkingDirectory: vi.fn(),
    };
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(service as never), {
      prefix: '/api/acp',
    });

    const response = await app.inject({
      method: 'POST',
      url,
      remoteAddress: '192.0.2.10',
      payload,
    });

    expect(response.statusCode).toBe(403);
    expect(service.refresh).not.toHaveBeenCalled();
    expect(service.materialize).not.toHaveBeenCalled();
    expect(service.validateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('returns structured unsupported refresh errors', async () => {
    const service = {
      refresh: vi
        .fn()
        .mockRejectedValue(
          new AcpMachineDiscoveryError(
            'unsupported_capability',
            'Agent discovery is unsupported',
            503,
          ),
        ),
    };
    app = Fastify({ logger: false });
    await app.register(createAcpAgentCliRoutes(service as never), {
      prefix: '/api/acp',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/acp/agent-cli/refresh',
      payload: { agentletId: 'machine-1' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'unsupported_capability',
    });
  });
});
