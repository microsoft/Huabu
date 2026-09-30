// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import canaryRedeployRoutes from './canary-redeploy.route.js';

import type { FastifyInstance } from 'fastify';

describe('Canary redeployment routes', () => {
  let app: FastifyInstance;
  const originalEnabled = process.env.HUABU_CANARY_REDEPLOY_ENABLED;

  beforeEach(async () => {
    delete process.env.HUABU_CANARY_REDEPLOY_ENABLED;
    app = Fastify({ logger: false });
    await app.register(canaryRedeployRoutes, {
      prefix: '/api/deployment/canary',
    });
  });

  afterEach(async () => {
    await app.close();
    if (originalEnabled === undefined) {
      delete process.env.HUABU_CANARY_REDEPLOY_ENABLED;
    } else {
      process.env.HUABU_CANARY_REDEPLOY_ENABLED = originalEnabled;
    }
  });

  it('lets the local owner inspect a disabled capability', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployment/canary',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: false,
      reason: 'disabled',
      branch: 'alpha',
    });
  });

  it('rejects non-owner callers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/deployment/canary',
      remoteAddress: '192.0.2.10',
    });
    expect(response.statusCode).toBe(403);
  });

  it('validates action request bodies and reports unavailable redeployment', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/deployment/canary/redeploy',
      payload: { branch: 'main' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'validation_failed' });

    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/deployment/canary/redeploy',
      payload: {},
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      code: 'canary_redeploy_unavailable',
    });
  });
});
