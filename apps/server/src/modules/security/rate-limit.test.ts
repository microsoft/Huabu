// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { GLOBAL_RATE_LIMIT_OPTIONS } from './rate-limit.js';

import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('global rate limit', () => {
  it('shares one budget across routes and returns retry metadata', async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, {
      ...GLOBAL_RATE_LIMIT_OPTIONS,
      max: 2,
    });
    app.get('/first', async () => ({ ok: true }));
    app.get('/second', async () => ({ ok: true }));

    const first = await app.inject({
      method: 'GET',
      url: '/first',
      remoteAddress: '192.0.2.10',
    });
    const second = await app.inject({
      method: 'GET',
      url: '/second',
      remoteAddress: '192.0.2.10',
    });
    const exceeded = await app.inject({
      method: 'GET',
      url: '/first',
      remoteAddress: '192.0.2.10',
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    expect(exceeded.statusCode).toBe(429);
    expect(exceeded.headers['retry-after']).toBeDefined();
    expect(exceeded.json()).toEqual({
      statusCode: 429,
      message: 'Rate limit exceeded',
      code: 'rate_limit_exceeded',
    });
  });

  it('uses the direct peer address instead of forwarded headers', async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, {
      ...GLOBAL_RATE_LIMIT_OPTIONS,
      max: 1,
    });
    app.get('/', async () => ({ ok: true }));

    const first = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });
    const samePeer = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    });
    const differentPeer = await app.inject({
      method: 'GET',
      url: '/',
      remoteAddress: '192.0.2.11',
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });

    expect(first.statusCode).toBe(200);
    expect(samePeer.statusCode).toBe(429);
    expect(differentPeer.statusCode).toBe(200);
  });
});
