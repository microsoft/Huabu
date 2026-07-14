import { get } from 'node:http';

import { AgentTeamError } from '@agenetes/agentlet-host';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAgentTeamRoutes,
  type AgentTeamSettingsRegistry,
} from './agent-team.route.js';

import type { FastifyInstance } from 'fastify';

function deployment() {
  return {
    id: 'deployment-1',
    alias: 'Reviewer',
    revision: 1,
    enabled: false,
    machine: 'machine-a',
    manifestPath: '/teams/reviewer/agentlet.yaml',
    harness: 'copilot',
    workingDirPath: '/teams/reviewer/workspaces/copilot',
    setup: { status: 'disabled' as const },
    setupLog: [],
  };
}

function createRegistry(): AgentTeamSettingsRegistry {
  const listeners = new Set<() => void>();
  return {
    listRoots: vi.fn(() => []),
    listMembers: vi.fn(() => []),
    listDeployments: vi.fn(() => []),
    getMemberConfig: vi.fn(() => {
      throw new Error('No members');
    }),
    onChange: vi.fn((handler, _onError) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
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
    createDeployment: vi.fn(() => deployment()),
    updateDeployment: vi.fn(() => deployment()),
    deleteDeployment: vi.fn(() => true),
    enableDeployment: vi.fn(async () => deployment()),
    disableDeployment: vi.fn(async () => deployment()),
    retryDeploymentSetup: vi.fn(async () => deployment()),
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
      createAgentTeamRoutes(() => registry),
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
      roots: [],
      members: [],
      deployments: [],
      configs: [],
    });
  });

  it('rejects remote Settings callers before reading the registry', async () => {
    const getRegistry = vi.fn(() => createRegistry());
    app = Fastify({ logger: false });
    await app.register(createAgentTeamRoutes(getRegistry), {
      prefix: '/api/agent-team',
    });

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
      createAgentTeamRoutes(() => registry),
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
    vi.mocked(registry.createDeployment).mockImplementationOnce(() => {
      throw new AgentTeamError('alias_conflict', 'Alias already exists');
    });
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(() => registry),
      {
        prefix: '/api/agent-team',
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-team/settings/deployments',
      payload: {
        alias: 'Reviewer',
        machine: 'machine-a',
        manifestPath: '/teams/reviewer/agentlet.yaml',
        harness: 'copilot',
        workingDirPath: '/teams/reviewer/workspaces/copilot',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      message: 'Alias already exists',
      code: 'alias_conflict',
    });
  });

  it('opens SSE with an initial Settings snapshot', async () => {
    const registry = createRegistry();
    app = Fastify({ logger: false });
    await app.register(
      createAgentTeamRoutes(() => registry),
      {
        prefix: '/api/agent-team',
      },
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected server address');
    }

    const payload = await new Promise<string>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${address.port}/api/agent-team/settings/events`,
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            data += chunk;
            if (data.includes('event: snapshot')) {
              response.destroy();
              resolve(data);
            }
          });
        },
      );
      request.on('error', reject);
    });

    expect(payload).toContain('event: snapshot');
    expect(payload).toContain('"roots":[]');
  });
});
