// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { originGuardPlugin } from './origin-guard.js';

const openApps: FastifyInstance[] = [];

// Mirror app.ts: the guard is registered on the root instance, and route
// modules are registered as sibling plugins.
async function buildApp() {
  const app = fastify();
  openApps.push(app);
  await app.register(originGuardPlugin);
  app.put('/root', async () => ({ ok: true }));
  await app.register(async (routes) => {
    routes.put('/module', async () => ({ ok: true }));
    routes.get('/module', async () => ({ ok: true }));
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('originGuardPlugin', () => {
  it.each(['/root', '/module'])(
    'blocks a cross-site write to %s',
    async (url) => {
      const app = await buildApp();

      const response = await app.inject({
        method: 'PUT',
        url,
        headers: { 'sec-fetch-site': 'cross-site' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'CROSS_SITE_BLOCKED' });
    },
  );

  it.each(['same-origin', 'same-site', 'none'])(
    'allows a write with Sec-Fetch-Site %s',
    async (site) => {
      const app = await buildApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/module',
        headers: { 'sec-fetch-site': site },
      });

      expect(response.statusCode).toBe(200);
    },
  );

  it('does not guard safe methods', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/module',
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    expect(response.statusCode).toBe(200);
  });

  it('blocks a write from a disallowed Origin without Fetch Metadata', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'PUT',
      url: '/module',
      headers: { origin: 'http://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'BAD_ORIGIN' });
  });

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:3001',
    'http://[::1]:5173',
  ])(
    'allows a write from the allowed Origin %s without Fetch Metadata',
    async (origin) => {
      const app = await buildApp();

      const response = await app.inject({
        method: 'PUT',
        url: '/module',
        // A non-loopback peer, so only the Origin check can admit it.
        remoteAddress: '192.0.2.10',
        headers: { origin },
      });

      expect(response.statusCode).toBe(200);
    },
  );

  it('allows a write without origin signals only from a loopback peer', async () => {
    const app = await buildApp();

    const local = await app.inject({
      method: 'PUT',
      url: '/module',
      remoteAddress: '127.0.0.1',
    });
    const remote = await app.inject({
      method: 'PUT',
      url: '/module',
      remoteAddress: '192.0.2.10',
    });

    expect(local.statusCode).toBe(200);
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toMatchObject({ code: 'NO_ORIGIN_NON_LOCAL' });
  });
});
