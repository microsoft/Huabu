// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CapabilityModule from './index.js';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  isOwner: vi.fn(),
  list: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CapabilityModule>();
  return {
    ...actual,
    capabilityProvisionService: {
      getConfig: mocks.getConfig,
      list: mocks.list,
      updateConfig: mocks.updateConfig,
    },
  };
});

vi.mock('../security/owner.js', () => ({
  isOwnerRequest: mocks.isOwner,
}));

const { default: capabilityRoutes } = await import('./capabilities.route.js');

let app: FastifyInstance | undefined;

async function buildApp(): Promise<FastifyInstance> {
  const instance = fastify();
  await instance.register(capabilityRoutes, { prefix: '/capabilities' });
  await instance.ready();
  return instance;
}

const maskedConfig = {
  manifest: {
    schema: 'huabu-capability/v1',
    id: 'web-search',
    version: '1.0.0',
    name: 'Web Search',
    description: 'Search the web.',
    storage: { namespace: 'integration.tavily' },
    consumers: { internal: true, pipeline: false, external: true },
    agent: { skill: 'SKILL.md', client: 'client.mjs' },
    configuration: [
      {
        id: 'apiKey',
        label: 'API key',
        type: 'secret',
        required: true,
      },
    ],
  },
  values: { apiKey: null },
  configuredFields: ['apiKey'],
  configured: true,
} as const;

beforeEach(() => {
  mocks.getConfig.mockReset();
  mocks.isOwner.mockReset().mockReturnValue(true);
  mocks.list.mockReset();
  mocks.updateConfig.mockReset();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('Capability settings routes', () => {
  it('returns discovery and masked configuration', async () => {
    mocks.list.mockReturnValue([
      {
        id: 'web-search',
        version: '1.0.0',
        name: 'Web Search',
        description: 'Search the web.',
        configured: true,
        availableToInternalAgent: true,
        availableToPipeline: false,
        availableToExternalAgent: true,
      },
    ]);
    mocks.getConfig.mockReturnValue(maskedConfig);
    app = await buildApp();

    const discovery = await app.inject({
      method: 'GET',
      url: '/capabilities',
    });
    const config = await app.inject({
      method: 'GET',
      url: '/capabilities/web-search',
    });

    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      capabilities: [{ id: 'web-search', configured: true }],
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      manifest: { id: 'web-search' },
      values: { apiKey: null },
      configuredFields: ['apiKey'],
      configured: true,
    });
    expect(config.body).not.toContain('test-secret');
  });

  it('requires owner authorization before updating configuration', async () => {
    mocks.isOwner.mockReturnValue(false);
    app = await buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/capabilities/web-search',
      payload: { values: { apiKey: 'test-secret' } },
    });

    expect(response.statusCode).toBe(403);
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('validates and delegates owner updates', async () => {
    mocks.updateConfig.mockResolvedValue(maskedConfig);
    app = await buildApp();

    const invalid = await app.inject({
      method: 'PUT',
      url: '/capabilities/web-search',
      payload: { values: { apiKey: { nested: true } } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(mocks.updateConfig).not.toHaveBeenCalled();

    const updated = await app.inject({
      method: 'PUT',
      url: '/capabilities/web-search',
      payload: { values: { apiKey: 'test-secret' } },
    });
    expect(updated.statusCode).toBe(200);
    expect(mocks.updateConfig).toHaveBeenCalledWith('web-search', {
      apiKey: 'test-secret',
    });
    expect(updated.body).not.toContain('test-secret');
  });
});
