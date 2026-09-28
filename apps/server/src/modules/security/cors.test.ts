// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import cors from '@fastify/cors';
import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createCorsOptions } from './cors.js';

const openApps: FastifyInstance[] = [];

async function buildApp() {
  const app = fastify();
  openApps.push(app);
  await app.register(
    cors,
    createCorsOptions(new Set(['localhost', 'huabu.example'])),
  );
  app.put('/resource', async () => ({ ok: true }));
  await app.ready();
  return app;
}

function preflight(app: FastifyInstance, origin: string, method: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/resource',
    headers: { origin, 'access-control-request-method': method },
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('CORS options', () => {
  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    'allows %s preflights from an allowed hostname',
    async (method) => {
      const app = await buildApp();

      const response = await preflight(app, 'http://localhost:5173', method);

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
      expect(response.headers['access-control-allow-methods']).toBe(
        'GET, HEAD, PUT, PATCH, POST, DELETE',
      );
    },
  );

  it('matches allowed hostnames on any scheme and port', async () => {
    const app = await buildApp();

    for (const origin of [
      'https://huabu.example',
      'http://huabu.example:8080',
    ]) {
      const response = await preflight(app, origin, 'PUT');
      expect(response.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('omits CORS headers for other and malformed origins', async () => {
    const app = await buildApp();

    for (const origin of ['http://evil.example', 'not a url']) {
      const response = await preflight(app, origin, 'PUT');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-methods']).toBeUndefined();
    }
  });

  it('does not allow credentials', async () => {
    const app = await buildApp();

    const response = await preflight(app, 'http://localhost:5173', 'PUT');

    expect(
      response.headers['access-control-allow-credentials'],
    ).toBeUndefined();
  });
});
