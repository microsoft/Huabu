// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import agentChangeReviewConfigRoutes from './change-review-config.route.js';

import type { FastifyInstance } from 'fastify';

describe('Agent change-review config routes', () => {
  let app: FastifyInstance;
  let dataDir: string;
  const originalDataDir = process.env.HUABU_DATA_DIR;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'huabu-change-review-route-'));
    process.env.HUABU_DATA_DIR = dataDir;
    app = Fastify({ logger: false });
    await app.register(agentChangeReviewConfigRoutes, {
      prefix: '/api/agent-change-review',
    });
  });

  afterEach(async () => {
    await app.close();
    if (originalDataDir === undefined) {
      delete process.env.HUABU_DATA_DIR;
    } else {
      process.env.HUABU_DATA_DIR = originalDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lets the local owner read and update the config', async () => {
    const initial = await app.inject({
      method: 'GET',
      url: '/api/agent-change-review/config',
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ autoAcceptSpaceChanges: false });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/agent-change-review/config',
      payload: { autoAcceptSpaceChanges: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ autoAcceptSpaceChanges: true });
  });

  it('rejects a non-owner request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/agent-change-review/config',
      remoteAddress: '192.0.2.10',
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects malformed config bodies', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/agent-change-review/config',
      payload: { autoAcceptSpaceChanges: 'yes' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation_failed' });
  });
});
