// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import agentResourceRoutes from './resources.route.js';

const mocks = vi.hoisted(() => ({
  gateway: {
    getAgentlet: vi.fn(),
    scanResources: vi.fn(),
    importResource: vi.fn(),
    scanResourceRefresh: vi.fn(),
    refreshResource: vi.fn(),
    deleteResource: vi.fn(),
  },
  registry: {
    get: vi.fn(),
    list: vi.fn(),
    register: vi.fn(),
    replaceOwn: vi.fn(),
    replaceProviderResources: vi.fn(),
    withdraw: vi.fn(),
  },
}));

vi.mock('@agenetes/agentlet-host', () => ({
  AgentletRequestError: class AgentletRequestError extends Error {
    rpcCode = -32602;
    data?: unknown;
  },
  ResourceRegistryError: class ResourceRegistryError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  getAgentletGateway: () => mocks.gateway,
  getResourceRegistry: () => mocks.registry,
  getSupervisedAgentletId: () => 'machine-a',
}));

const candidate = {
  id: 'slides',
  name: 'Slides',
  sourcePath: '/skills/slides',
  sourceContent: '# Slides',
  sourceRevision: 'a'.repeat(64),
};

const resource = {
  schemaVersion: 2 as const,
  id: 'slides',
  name: 'Slides',
  provider: 'machine-a',
  sourceContent: '# Slides',
  userContent: '',
};

let app: FastifyInstance | undefined;

beforeEach(async () => {
  mocks.gateway.getAgentlet.mockReturnValue({ status: 'connected' });
  app = Fastify({ logger: false });
  await app.register(agentResourceRoutes, { prefix: '/api/acp' });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.clearAllMocks();
});

describe('Agent Resource management routes', () => {
  it('scans through the supervised Agentlet without mutating the registry', async () => {
    mocks.gateway.scanResources.mockResolvedValue({
      rootPath: '/skills',
      candidates: [candidate],
      diagnostics: [],
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/api/acp/resources/import/scan',
      payload: { rootPath: '/skills' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.gateway.scanResources).toHaveBeenCalledWith('machine-a', {
      rootPath: '/skills',
    });
    expect(mocks.registry.register).not.toHaveBeenCalled();
  });

  it('imports source data and stores user customization in the registry', async () => {
    mocks.registry.get.mockReturnValue(undefined);
    mocks.gateway.importResource.mockResolvedValue({ resource, created: true });
    mocks.registry.register.mockImplementation((value) => value);

    const response = await app!.inject({
      method: 'POST',
      url: '/api/acp/resources/import',
      payload: {
        id: 'slides',
        sourcePath: '/skills/slides',
        expectedRevision: 'a'.repeat(64),
        displayName: 'My Slides',
        userContent: 'Use our template.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.registry.register).toHaveBeenCalledWith({
      ...resource,
      displayName: 'My Slides',
      userContent: 'Use our template.',
    });
  });

  it('removes the managed copy when registry registration fails', async () => {
    mocks.registry.get.mockReturnValue(undefined);
    mocks.gateway.importResource.mockResolvedValue({ resource, created: true });
    mocks.registry.register.mockImplementation(() => {
      throw new Error('registry unavailable');
    });
    mocks.gateway.deleteResource.mockResolvedValue({ removed: true });

    const response = await app!.inject({
      method: 'POST',
      url: '/api/acp/resources/import',
      payload: {
        id: 'slides',
        sourcePath: '/skills/slides',
        expectedRevision: 'a'.repeat(64),
      },
    });

    expect(response.statusCode).toBe(500);
    expect(mocks.gateway.deleteResource).toHaveBeenCalledWith('machine-a', {
      id: 'slides',
    });
  });

  it('does not remove a reused managed copy when registry registration fails', async () => {
    mocks.registry.get.mockReturnValue(undefined);
    mocks.gateway.importResource.mockResolvedValue({
      resource,
      created: false,
    });
    mocks.registry.register.mockImplementation(() => {
      throw new Error('registry unavailable');
    });

    const response = await app!.inject({
      method: 'POST',
      url: '/api/acp/resources/import',
      payload: {
        id: 'slides',
        sourcePath: '/skills/slides',
        expectedRevision: 'a'.repeat(64),
      },
    });

    expect(response.statusCode).toBe(500);
    expect(mocks.gateway.deleteResource).not.toHaveBeenCalled();
  });

  it('updates only user-owned fields', async () => {
    const customized = {
      ...resource,
      displayName: 'My Slides',
      userContent: 'Old',
    };
    mocks.registry.get.mockReturnValue(customized);
    mocks.registry.replaceOwn.mockImplementation((_provider, value) => value);

    const response = await app!.inject({
      method: 'PATCH',
      url: '/api/acp/resources/slides',
      payload: { displayName: null, userContent: 'New' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.registry.replaceOwn).toHaveBeenCalledWith('machine-a', {
      ...resource,
      displayName: undefined,
      userContent: 'New',
    });
  });

  it('refreshes source fields while preserving user customization', async () => {
    const current = {
      ...resource,
      displayName: 'My Slides',
      userContent: 'Use our template.',
    };
    const refreshed = {
      ...resource,
      name: 'Slides v2',
      sourceContent: '# Slides v2',
    };
    mocks.registry.get.mockReturnValue(current);
    mocks.gateway.refreshResource.mockResolvedValue({ resource: refreshed });
    mocks.registry.replaceOwn.mockImplementation((_provider, value) => value);

    const response = await app!.inject({
      method: 'POST',
      url: '/api/acp/resources/slides/refresh',
      payload: { expectedRevision: 'b'.repeat(64) },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.registry.replaceOwn).toHaveBeenCalledWith('machine-a', {
      ...refreshed,
      displayName: 'My Slides',
      userContent: 'Use our template.',
    });
  });

  it('preserves customization changed while refresh is in flight', async () => {
    const beforeRefresh = { ...resource, userContent: 'Before' };
    const afterRefresh = {
      ...resource,
      displayName: 'Latest',
      userContent: 'After',
    };
    const refreshed = {
      ...resource,
      name: 'Slides v2',
      sourceContent: '# Slides v2',
    };
    mocks.registry.get
      .mockReturnValueOnce(beforeRefresh)
      .mockReturnValueOnce(afterRefresh);
    mocks.gateway.refreshResource.mockResolvedValue({ resource: refreshed });
    mocks.registry.replaceOwn.mockImplementation((_provider, value) => value);

    const response = await app!.inject({
      method: 'POST',
      url: '/api/acp/resources/slides/refresh',
      payload: { expectedRevision: 'b'.repeat(64) },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.registry.replaceOwn).toHaveBeenCalledWith('machine-a', {
      ...refreshed,
      displayName: 'Latest',
      userContent: 'After',
    });
  });

  it('deletes the managed copy before withdrawing the registry record', async () => {
    mocks.registry.get.mockReturnValue(resource);
    mocks.gateway.deleteResource.mockResolvedValue({ removed: true });

    const response = await app!.inject({
      method: 'DELETE',
      url: '/api/acp/resources/slides',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.gateway.deleteResource).toHaveBeenCalledWith('machine-a', {
      id: 'slides',
    });
    expect(mocks.registry.withdraw).toHaveBeenCalledWith('machine-a', 'slides');
  });

  it('withdraws the registry record when an idempotent delete reports already absent', async () => {
    mocks.registry.get.mockReturnValue(resource);
    mocks.gateway.deleteResource.mockResolvedValue({ removed: false });

    const response = await app!.inject({
      method: 'DELETE',
      url: '/api/acp/resources/slides',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ removed: true });
    expect(mocks.registry.withdraw).toHaveBeenCalledWith('machine-a', 'slides');
  });
});
