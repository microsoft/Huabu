// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHarnessDiscoveryRoutes } from './harness-discovery.route.js';
import { HarnessProfileDiscoveryError } from './harness-profile-discovery.js';
import { markBasicAuthenticated } from '../../security/owner.js';

import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

async function setup(owner = false) {
  const discover = vi.fn(async (agentletId: string) => ({
    agentletId,
    harnesses: [],
  }));
  app = Fastify();
  if (owner)
    app.addHook('onRequest', async (request) => {
      markBasicAuthenticated(request);
    });
  await app.register(
    createHarnessDiscoveryRoutes(() => ({ discover })),
    { prefix: '/api/acp' },
  );
  return discover;
}

describe('owner device detection', () => {
  it('routes exactly one explicit target and returns the reconciliation result', async () => {
    const discover = await setup();
    const result = await app.inject({
      method: 'POST',
      url: '/api/acp/agentlets/device-b/discover',
      payload: {},
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ agentletId: 'device-b', harnesses: [] });
    expect(discover).toHaveBeenCalledExactlyOnceWith('device-b');
  });

  it('denies unauthenticated remote access before detection', async () => {
    const discover = await setup();
    const result = await app.inject({
      method: 'POST',
      url: '/api/acp/agentlets/device/discover',
      payload: {},
      remoteAddress: '192.0.2.1',
    });
    expect(result.statusCode).toBe(403);
    expect(discover).not.toHaveBeenCalled();
  });

  it('allows the authenticated remote owner', async () => {
    const discover = await setup(true);
    const result = await app.inject({
      method: 'POST',
      url: '/api/acp/agentlets/device/discover',
      payload: {},
      remoteAddress: '192.0.2.1',
    });
    expect(result.statusCode).toBe(200);
    expect(discover).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    null,
    [],
    { prepareWorkspaces: false },
    { command: 'ignored' },
  ])('rejects invalid bodies before detection: %j', async (payload) => {
    const discover = await setup();
    const result = await app.inject({
      method: 'POST',
      url: '/api/acp/agentlets/device/discover',
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: { 'content-type': 'application/json' },
          }),
    });
    expect(result.statusCode).toBe(400);
    expect(discover).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only device identities', async () => {
    const discover = await setup();
    const result = await app.inject({
      method: 'POST',
      url: '/api/acp/agentlets/%20/discover',
      payload: {},
    });
    expect(result.statusCode).toBe(400);
    expect(discover).not.toHaveBeenCalled();
  });

  it.each([
    ['agentlet_unavailable', 409],
    ['harness_discovery_stale', 409],
    ['harness_discovery_unsupported', 503],
    ['harness_discovery_unavailable', 503],
    ['profile_registry_unavailable', 503],
    ['harness_reconciliation_failed', 500],
  ] as const)('returns explicit %s errors', async (code, status) => {
    const discover = await setup();
    discover.mockRejectedValueOnce(
      new HarnessProfileDiscoveryError(
        code,
        status,
        'Safe message',
        { createdProfileIds: ['saved'] },
        { cause: new Error('private error') },
      ),
    );
    const result = await app.inject({
      method: 'POST',
      url: '/api/acp/agentlets/device/discover',
      payload: {},
    });
    expect(result.statusCode).toBe(status);
    expect(result.json()).toEqual({
      code,
      message: 'Safe message',
      details: { createdProfileIds: ['saved'] },
    });
    expect(result.body).not.toContain('private error');
  });

  it('does not expose unexpected errors as successful empty results', async () => {
    const discover = await setup();
    discover.mockRejectedValueOnce(new Error('private path'));
    const result = await app.inject({
      method: 'POST',
      url: '/api/acp/agentlets/device/discover',
      payload: {},
    });
    expect(result.statusCode).toBe(500);
    expect(result.json().code).toBe('harness_reconciliation_failed');
    expect(result.body).not.toContain('private path');
  });

  it('fails explicitly before coordinator initialization', async () => {
    app = Fastify();
    await app.register(
      createHarnessDiscoveryRoutes(() => undefined),
      { prefix: '/api/acp' },
    );
    const result = await app.inject({
      method: 'POST',
      url: '/api/acp/agentlets/device/discover',
      payload: {},
    });
    expect(result.statusCode).toBe(503);
  });
});
