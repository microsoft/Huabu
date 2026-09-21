// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import agentDefaultsRoutes from './agent-defaults.route.js';
import { createApplicationRateLimitOptions } from '../security/rate-limit.js';

import type { AgentDefaults } from '@huabu/shared';
import type { FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  getProfile: vi.fn(),
  getAgentlet: vi.fn(),
  getCache: vi.fn(),
}));
vi.mock('./agent-defaults.js', () => ({
  getAgentDefaults: mocks.get,
  setAgentDefaults: mocks.set,
}));
vi.mock('@agenetes/agentlet-host', () => ({
  getAgentProfileRegistry: () => ({ getProfile: mocks.getProfile }),
  getAgentletGateway: () => ({ getAgentlet: mocks.getAgentlet }),
}));
vi.mock('./acp/profile-schema-cache.js', () => ({
  getProfileSchemaCache: mocks.getCache,
}));

let app: FastifyInstance;
const url = '/api/agent/defaults';
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.get.mockReturnValue({ profileId: null, functionalModel: '' });
  mocks.set.mockImplementation((value: AgentDefaults) => value);
  app = Fastify({ logger: false });
  await app.register(rateLimit, createApplicationRateLimitOptions({ max: 10 }));
  await app.register(agentDefaultsRoutes, { prefix: url });
});
afterEach(async () => {
  await app.close();
});

describe('owner-only Agent defaults', () => {
  it.each(['GET', 'PUT'] as const)(
    'rate-limits %s before accessing settings or Profile data',
    async (method) => {
      for (let index = 0; index < 10; index += 1) {
        expect((await app.inject(url)).statusCode).toBe(200);
      }
      vi.clearAllMocks();
      const response = await app.inject({
        method,
        url,
        ...(method === 'PUT'
          ? { payload: { profileId: null, functionalModel: '' } }
          : {}),
      });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ code: 'RATE_LIMITED' });
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.set).not.toHaveBeenCalled();
      expect(mocks.getProfile).not.toHaveBeenCalled();
      expect(mocks.getCache).not.toHaveBeenCalled();
    },
  );

  it.each(['', '/'])(
    'serves the prefixed endpoint with suffix "%s"',
    async (suffix) => {
      expect((await app.inject(url + suffix)).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: url + suffix,
            payload: { profileId: null, functionalModel: '' },
          })
        ).statusCode,
      ).toBe(200);
    },
  );

  it('reads without persisting, discovery, or session creation', async () => {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      defaults: { profileId: null, functionalModel: '' },
      selectionState: 'unconfigured',
      modelCapability: 'unknown',
    });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.getProfile).not.toHaveBeenCalled();
    expect(mocks.getAgentlet).not.toHaveBeenCalled();
    expect(mocks.getCache).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT'] as const)(
    'rejects nonowner %s requests',
    async (method) => {
      const response = await app.inject({
        method,
        url,
        remoteAddress: '192.0.2.10',
        ...(method === 'PUT' ? { payload: { profileId: null } } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.set).not.toHaveBeenCalled();
    },
  );

  it('validates bodies and rejects unknown or internal Profiles', async () => {
    for (const payload of [
      { profileId: 'unknown', functionalModel: '' },
      { profileId: 'huabu', functionalModel: '' },
      { profileId: 'external', functionalModel: 1 },
    ]) {
      expect(
        (await app.inject({ method: 'PUT', url, payload })).statusCode,
      ).toBe(400);
    }
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('persists normalized overrides without inferring support from editable labels', async () => {
    mocks.getProfile.mockReturnValue({
      id: 'external',
      agentletId: 'machine',
      metadata: { cliId: 'copilot' },
      launch: { kind: 'acp-command', command: 'copilot --acp' },
    });
    mocks.getAgentlet.mockReturnValue({ status: 'connected' });
    const response = await app.inject({
      method: 'PUT',
      url,
      payload: { profileId: 'external', functionalModel: '  fast  ' },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith({
      profileId: 'external',
      functionalModel: 'fast',
    });
    expect(response.json()).toMatchObject({
      selectionState: 'available',
      modelCapability: 'unsupported',
    });
  });

  it('projects missing and offline selections without switching them', async () => {
    mocks.get.mockReturnValue({ profileId: 'selected', functionalModel: '' });
    expect((await app.inject(url)).json().selectionState).toBe('deleted');
    mocks.getProfile.mockReturnValue({
      id: 'selected',
      agentletId: 'offline',
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
    });
    expect((await app.inject(url)).json().selectionState).toBe('offline');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each([
    { availableModels: [{ modelId: 'fast', name: 'Fast' }] },
    {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'fast',
          options: [{ value: 'fast', name: 'Fast' }],
        },
      ],
    },
  ])(
    'uses cached observed model selectors without spawning a session',
    async (cached) => {
      mocks.get.mockReturnValue({ profileId: 'external', functionalModel: '' });
      mocks.getProfile.mockReturnValue({
        id: 'external',
        agentletId: 'machine',
        launch: { kind: 'acp-harness', harnessId: 'copilot' },
      });
      mocks.getCache.mockReturnValue(cached);
      const response = await app.inject(url);
      expect(response.json().modelCapability).toBe('supported');
      expect(mocks.getCache).toHaveBeenCalledWith('external');
      expect(mocks.set).not.toHaveBeenCalled();
    },
  );

  it('does not interpret partial or empty cached metadata as unsupported', async () => {
    mocks.get.mockReturnValue({ profileId: 'external', functionalModel: '' });
    mocks.getProfile.mockReturnValue({
      id: 'external',
      agentletId: 'machine',
      launch: { kind: 'acp-harness', harnessId: 'copilot' },
    });
    mocks.getCache.mockReturnValue({ availableModels: [], configOptions: [] });
    expect((await app.inject(url)).json().modelCapability).toBe('unknown');
  });

  it('returns an explicit error rather than defaults on corrupt storage', async () => {
    mocks.get.mockImplementation(() => {
      throw new Error('Invalid Agent defaults file');
    });
    const response = await app.inject(url);
    expect(response.statusCode).toBe(500);
    expect(response.json().message).toContain('Invalid Agent defaults file');
  });
});
