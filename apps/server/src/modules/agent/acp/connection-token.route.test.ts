// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import connectionTokenRoutes from './connection-token.route.js';

const mocks = vi.hoisted(() => ({
  InvalidOriginError: class InvalidOriginError extends Error {},
  buildCommand: vi.fn(),
  getConfig: vi.fn(),
  isOwner: vi.fn(),
  setToken: vi.fn(),
}));

vi.mock('../../../connection-token.js', () => ({
  InvalidAgentletConnectionOriginError: mocks.InvalidOriginError,
  buildAgentletConnectionCommand: mocks.buildCommand,
  getConnectionTokenConfig: mocks.getConfig,
  setConnectionToken: mocks.setToken,
}));

vi.mock('../../security/owner.js', () => ({
  isOwnerRequest: mocks.isOwner,
}));

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

describe('connection token routes', () => {
  it('keeps token settings owner-only and never returns token material', async () => {
    mocks.isOwner.mockReturnValue(false);
    const server = await setup();

    const response = await server.inject('/api/acp/connection-token');

    expect(response.statusCode).toBe(403);
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(response.body).not.toContain('token-value');
  });

  it('returns only the credential source and writability', async () => {
    mocks.isOwner.mockReturnValue(true);
    mocks.getConfig.mockReturnValue({ source: 'stored', writable: true });
    const server = await setup();

    const response = await server.inject('/api/acp/connection-token');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ source: 'stored', writable: true });
  });

  it('validates updates and propagates persistence failures', async () => {
    mocks.isOwner.mockReturnValue(true);
    mocks.setToken.mockRejectedValue(new Error('credential store unavailable'));
    const server = await setup();

    const invalid = await server.inject({
      method: 'PUT',
      url: '/api/acp/connection-token',
      payload: { token: '' },
    });
    const failed = await server.inject({
      method: 'PUT',
      url: '/api/acp/connection-token',
      payload: { token: 'replacement' },
    });

    expect(invalid.statusCode).toBe(400);
    expect(failed.statusCode).toBe(500);
    expect(mocks.setToken).toHaveBeenCalledOnce();
    expect(mocks.setToken).toHaveBeenCalledWith('replacement');
  });

  it('returns a no-store command response for a valid browser origin', async () => {
    mocks.isOwner.mockReturnValue(true);
    mocks.buildCommand.mockReturnValue({
      command: "agentlet daemon --token 'secret'",
      warnings: ['loopback'],
    });
    const server = await setup();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-command',
      payload: { origin: 'http://localhost:5173' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(mocks.buildCommand).toHaveBeenCalledWith('http://localhost:5173');
  });

  it('rejects malformed and non-origin command inputs', async () => {
    mocks.isOwner.mockReturnValue(true);
    mocks.buildCommand.mockImplementation(() => {
      throw new mocks.InvalidOriginError('invalid origin');
    });
    const server = await setup();

    const malformed = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-command',
      payload: { origin: 'not-a-url' },
    });
    const withPath = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-command',
      payload: { origin: 'https://example.com/path' },
    });

    expect(malformed.statusCode).toBe(400);
    expect(withPath.statusCode).toBe(400);
  });

  it('rejects a browser origin that differs from the request origin', async () => {
    mocks.isOwner.mockReturnValue(true);
    const server = await setup();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-command',
      headers: { origin: 'https://huabu.example' },
      payload: { origin: 'https://other.example' },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.buildCommand).not.toHaveBeenCalled();
  });

  it('does not disguise command-generation failures as invalid input', async () => {
    mocks.isOwner.mockReturnValue(true);
    mocks.buildCommand.mockImplementation(() => {
      throw new Error('runtime config unavailable');
    });
    const server = await setup();

    const response = await server.inject({
      method: 'POST',
      url: '/api/acp/connection-command',
      payload: { origin: 'https://huabu.example' },
    });

    expect(response.statusCode).toBe(500);
  });
});
