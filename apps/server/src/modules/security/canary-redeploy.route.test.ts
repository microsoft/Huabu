// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import canaryRedeployRoutes from './canary-redeploy.route.js';

import type { FastifyInstance } from 'fastify';

describe('Canary redeployment routes', () => {
  let app: FastifyInstance;
  let dataDir: string;
  const originalEnabled = process.env.HUABU_CANARY_REDEPLOY_ENABLED;
  const originalDataDir = process.env.HUABU_DATA_DIR;

  beforeEach(async () => {
    delete process.env.HUABU_CANARY_REDEPLOY_ENABLED;
    dataDir = mkdtempSync(join(tmpdir(), 'huabu-canary-route-'));
    process.env.HUABU_DATA_DIR = dataDir;
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
    if (originalDataDir === undefined) {
      delete process.env.HUABU_DATA_DIR;
    } else {
      process.env.HUABU_DATA_DIR = originalDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
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
      configuredBranch: null,
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
      payload: { expectedBranch: 'alpha' },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      code: 'canary_redeploy_unavailable',
    });
  });

  it('validates branch configuration before capability checks', async () => {
    const malformed = await app.inject({
      method: 'PUT',
      url: '/api/deployment/canary/config',
      payload: { branch: '' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'validation_failed' });

    const unavailable = await app.inject({
      method: 'PUT',
      url: '/api/deployment/canary/config',
      payload: { branch: 'x/alpha' },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      code: 'canary_redeploy_unavailable',
    });
  });
});
