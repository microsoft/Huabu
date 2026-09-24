// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostGuardPlugin, originHostname } from './host-guard.js';

const openApps: FastifyInstance[] = [];

// Mirror app.ts: the guard is registered on the root instance, and route
// modules are registered as sibling plugins.
async function buildApp() {
  const app = fastify();
  openApps.push(app);
  await app.register(hostGuardPlugin);
  app.get('/root', async () => ({ ok: true }));
  await app.register(async (routes) => {
    routes.get('/module', async () => ({ ok: true }));
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('hostGuardPlugin', () => {
  it.each(['/root', '/module'])(
    'rejects a disallowed Host on %s',
    async (url) => {
      const app = await buildApp();

      const response = await app.inject({
        method: 'GET',
        url,
        headers: { host: 'evil.example' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'INVALID_HOST' });
    },
  );

  it.each(['localhost:3001', '127.0.0.1', '[::1]:3001', 'LOCALHOST'])(
    'accepts the built-in loopback Host %s',
    async (host) => {
      const app = await buildApp();

      const response = await app.inject({
        method: 'GET',
        url: '/module',
        headers: { host },
      });

      expect(response.statusCode).toBe(200);
    },
  );

  it('accepts hostnames from HUABU_ALLOWED_HOSTS', async () => {
    vi.stubEnv('HUABU_ALLOWED_HOSTS', 'huabu.example, [fd00::1]');
    const app = await buildApp();

    for (const host of ['huabu.example:8443', '[fd00::1]:3001']) {
      const response = await app.inject({
        method: 'GET',
        url: '/module',
        headers: { host },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('lets CORS preflights through', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/module',
      headers: { host: 'evil.example' },
    });

    expect(response.statusCode).not.toBe(403);
  });
});

describe('originHostname', () => {
  it.each([
    ['http://localhost:5173', 'localhost'],
    ['https://HUABU.example', 'huabu.example'],
    ['http://127.0.0.1:3001', '127.0.0.1'],
    ['http://[::1]:5173', '[::1]'],
    ['https://[FD00::1]', '[fd00::1]'],
  ])('reads %s as %s', (origin, hostname) => {
    expect(originHostname(origin)).toBe(hostname);
  });

  it.each(['null', 'not a url', ''])('rejects %j', (origin) => {
    expect(originHostname(origin)).toBeNull();
  });
});
