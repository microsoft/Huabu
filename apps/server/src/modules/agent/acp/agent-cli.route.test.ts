// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAcpAgentCliRoutes } from './agent-cli.route.js';
import { markBasicAuthenticated } from '../../security/owner.js';

import type { FastifyInstance } from 'fastify';

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

  it('rejects remote callers before probing the host', async () => {
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

  it('allows the authenticated remote owner to probe the host', async () => {
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
});
