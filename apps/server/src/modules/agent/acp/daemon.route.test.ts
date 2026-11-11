// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import acpAgentletRoutes from './daemon.route.js';
import { registerLocalTestIdentity } from '../../../test-support/local-identity.js';

const supervisor = vi.hoisted(() => ({
  getStatus: vi.fn(() => ({ online: true, restartAttempt: 0 })),
  restart: vi.fn(() => ({ online: false, restartAttempt: 0 })),
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getDaemonSupervisor: () => supervisor,
}));

let app: FastifyInstance | undefined;

async function setup() {
  app = Fastify({ logger: false });
  registerLocalTestIdentity(app);
  await app.register(acpAgentletRoutes, { prefix: '/api/acp' });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

it('reports and restarts the local owner’s supervised worker', async () => {
  const server = await setup();
  expect((await server.inject('/api/acp/agentlet')).json()).toEqual({
    online: true,
    restartAttempt: 0,
  });
  const restart = await server.inject({
    method: 'POST',
    url: '/api/acp/agentlet/restart',
  });
  expect(restart.statusCode).toBe(200);
  expect(supervisor.restart).toHaveBeenCalledOnce();
});

it('neither reports nor starts a worker for a Bubble administrator', async () => {
  const server = await setup();
  const { openPersonalSettings, useCaller } =
    await import('../../identity/personal-settings.js');
  const [status, restart] = await openPersonalSettings(async () => {
    useCaller({
      principal: { principalId: 'admin', kind: 'user' },
      member: true,
      owner: true,
      access: {
        can: async () => true,
        claim: async () => {},
        workspaces: async () => [],
      },
    });
    return Promise.all([
      server.inject('/api/acp/agentlet'),
      server.inject({ method: 'POST', url: '/api/acp/agentlet/restart' }),
    ]);
  });
  expect(status.statusCode).toBe(404);
  expect(restart.statusCode).toBe(404);
  expect(restart.json()).toMatchObject({ code: 'AGENTLET_UNAVAILABLE' });
  expect(supervisor.getStatus).not.toHaveBeenCalled();
  expect(supervisor.restart).not.toHaveBeenCalled();
});
