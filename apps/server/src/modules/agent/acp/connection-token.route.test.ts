// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import connectionTokenRoutes from './connection-token.route.js';

const mocks = vi.hoisted(() => ({
  InvalidOriginError: class InvalidOriginError extends Error {},
  InvalidEnvFileError: class InvalidEnvFileError extends Error {},
  buildCommand: vi.fn(),
  isOwner: vi.fn(),
  getToken: vi.fn(),
}));
vi.mock('../../../connection-token.js', () => ({
  InvalidAgentletConnectionOriginError: mocks.InvalidOriginError,
  InvalidAgentletConnectionEnvFileError: mocks.InvalidEnvFileError,
  buildAgentletConnectionCommand: mocks.buildCommand,
  getConnectionToken: mocks.getToken,
}));
vi.mock('./runtime-config.js', () => ({
  getExternalAgentRuntimeConfig: () => ({ maxAgents: 7 }),
}));
vi.mock('../../security/owner.js', () => ({ isOwnerRequest: mocks.isOwner }));

let app: FastifyInstance | undefined;
async function setup() {
  app = Fastify({ logger: false });
  await app.register(connectionTokenRoutes, { prefix: '/api/acp' });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.resetAllMocks();
});
const payload = {
  origin: 'https://huabu.example',
  shell: 'posix',
  format: 'command',
};

describe('explicit owner-only connection copy', () => {
  it('returns no-store structured credentials only to an owner', async () => {
    const server = await setup();
    mocks.isOwner.mockReturnValue(false);
    let response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-credentials',
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(mocks.getToken).not.toHaveBeenCalled();
    mocks.isOwner.mockReturnValue(true);
    mocks.getToken.mockReturnValue('private-token');
    response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-credentials',
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ token: 'private-token', maxAgents: 7 });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
  });
  it('rejects credential overrides in a desktop connection request', async () => {
    mocks.isOwner.mockReturnValue(true);
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-credentials',
      payload: { token: 'replacement', origin: 'https://other.test' },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
  it('removes both token configuration endpoints', async () => {
    mocks.isOwner.mockReturnValue(true);
    const server = await setup();
    expect((await server.inject('/api/acp/connection-token')).statusCode).toBe(
      404,
    );
    expect(
      (
        await server.inject({
          method: 'PUT',
          url: '/api/acp/connection-token',
          payload: { token: 'replacement' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('rejects non-owner callers before generating credential-bearing content', async () => {
    mocks.isOwner.mockReturnValue(false);
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-command',
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(mocks.buildCommand).not.toHaveBeenCalled();
  });
  it.each(['command', 'env-file'])(
    'returns only explicit no-store %s copy content',
    async (format) => {
      mocks.isOwner.mockReturnValue(true);
      mocks.buildCommand.mockReturnValue({
        content: 'explicit secret-bearing copy text',
        source: 'managed',
        warnings: ['loopback'],
      });
      const server = await setup();
      const response = await server.inject({
        method: 'POST',
        url: '/api/acp/connection-command',
        payload: { ...payload, format },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      expect(response.json().source).toBe('managed');
      expect(mocks.buildCommand).toHaveBeenCalledWith({ ...payload, format });
    },
  );
  it.each([
    { origin: 'not-a-url', shell: 'posix', format: 'command' },
    { origin: 'https://huabu.example' },
    { ...payload, shell: 'cmd' },
    { ...payload, format: 'invalid' },
    { ...payload, token: 'caller-override' },
  ])('validates every body field before calling the builder', async (body) => {
    mocks.isOwner.mockReturnValue(true);
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-command',
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.buildCommand).not.toHaveBeenCalled();
  });
  it('rejects mismatched browser origin', async () => {
    mocks.isOwner.mockReturnValue(true);
    const server = await setup();
    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-command',
      headers: { origin: 'https://other.example' },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.buildCommand).not.toHaveBeenCalled();
  });
  it('reports known input problems without disguising operational failures', async () => {
    mocks.isOwner.mockReturnValue(true);
    const server = await setup();
    for (const error of [
      new mocks.InvalidOriginError('invalid origin'),
      new mocks.InvalidEnvFileError('Use command format'),
      new Error('runtime unavailable'),
    ]) {
      mocks.buildCommand.mockImplementationOnce(() => {
        throw error;
      });
      const response = await server.inject({
        method: 'POST',
        url: '/api/acp/connection-command',
        payload,
      });
      expect(response.statusCode).toBe(error.constructor === Error ? 500 : 400);
    }
  });
});
