// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import rateLimit from '@fastify/rate-limit';
import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApplicationRateLimitOptions } from './rate-limit.js';

const openApps: FastifyInstance[] = [];

async function buildApp(max = 2, timeWindow = 60_000) {
  const app = fastify();
  openApps.push(app);
  await app.register(
    rateLimit,
    createApplicationRateLimitOptions({ max, timeWindow }),
  );
  app.get('/protected', async () => ({ ok: true }));
  app.get('/api/deployment/readiness', async () => ({ ready: true }));
  app.options('/protected', async (_request, reply) => reply.code(204).send());
  app.get('/stream', async (_request, reply) =>
    reply
      .type('text/event-stream')
      .send(': connected\n\nevent: update\ndata: {}\n\n: ping\n\n'),
  );
  await app.ready();
  return app;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('application-wide rate limiting', () => {
  it('returns the canonical 429 body and standard retry headers', async () => {
    const app = await buildApp(1);
    await app.inject({ method: 'GET', url: '/protected' });

    const response = await app.inject({ method: 'GET', url: '/protected' });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 60 },
    });
    expect(response.headers).toMatchObject({
      'retry-after': '60',
      'x-ratelimit-limit': '1',
      'x-ratelimit-remaining': '0',
    });
  });

  it('resets admission after the configured window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00Z'));
    const app = await buildApp(1, 1_000);
    await app.inject({ method: 'GET', url: '/protected' });
    expect(
      (await app.inject({ method: 'GET', url: '/protected' })).statusCode,
    ).toBe(429);

    vi.setSystemTime(new Date('2026-09-18T00:00:01Z'));

    expect(
      (await app.inject({ method: 'GET', url: '/protected' })).statusCode,
    ).toBe(200);
  });

  it('exempts only preflight and deployment readiness requests', async () => {
    const app = await buildApp(1);
    for (let index = 0; index < 3; index += 1) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/deployment/readiness',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'OPTIONS', url: '/protected' })).statusCode,
      ).toBe(204);
    }

    expect(
      (await app.inject({ method: 'GET', url: '/protected' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/protected' })).statusCode,
    ).toBe(429);
  });

  it('shares a direct-peer bucket across auth mechanisms', async () => {
    const app = await buildApp(2);
    await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic owner' },
    });
    await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer agent' },
    });

    expect(
      (await app.inject({ method: 'GET', url: '/protected' })).statusCode,
    ).toBe(429);
  });

  it('ignores spoofed forwarding headers and separates real peers', async () => {
    const app = await buildApp(1);
    await app.inject({
      method: 'GET',
      url: '/protected',
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/protected',
          remoteAddress: '192.0.2.10',
          headers: { 'x-forwarded-for': '203.0.113.1' },
        })
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/protected',
          remoteAddress: '192.0.2.11',
          headers: { 'x-forwarded-for': '198.51.100.1' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('counts an SSE connection once rather than its streamed frames', async () => {
    const app = await buildApp(2);

    const stream = await app.inject({ method: 'GET', url: '/stream' });

    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain(': ping');
    expect(
      (await app.inject({ method: 'GET', url: '/protected' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/protected' })).statusCode,
    ).toBe(429);
  });

  it('rejects uploads before parsing their request body', async () => {
    const app = fastify();
    openApps.push(app);
    let parsedBodies = 0;
    await app.register(
      rateLimit,
      createApplicationRateLimitOptions({ max: 1 }),
    );
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        parsedBodies += 1;
        done(null, body);
      },
    );
    app.get('/protected', async () => ({ ok: true }));
    app.post('/upload', async () => ({ uploaded: true }));
    await app.ready();
    await app.inject({ method: 'GET', url: '/protected' });

    const response = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('large upload placeholder'),
    });

    expect(response.statusCode).toBe(429);
    expect(parsedBodies).toBe(0);
  });
});
