// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createBubbleIdentityService } from './bubble.js';
import { resolveIdentityConfig } from './config.js';
import { registerIdentity } from './http.js';
import { createLocalIdentityService } from './local.js';
import { isOwnerRequest } from '../security/owner.js';

import type { IdentityService } from './service.js';
import type { FastifyInstance } from 'fastify';

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

function host(service: IdentityService) {
  const app = Fastify();
  servers.push(app);
  registerIdentity(app, {
    service,
    getConnectionToken: () => 'machine-secret',
  });
  app.get('/api/data', async () => ({ private: true }));
  app.get('/api/settings', async (request, reply) => {
    if (!isOwnerRequest(request))
      return reply.code(403).send({ code: 'OWNER_REQUIRED' });
    return { private: true };
  });
  app.get('/api/rfs/space/content', async () => ({ content: 'private' }));
  app.get('/api/rfs/space/skill', async () => ({ skill: 'public' }));
  app.options('/api/data', async () => ({}));
  return app;
}

async function bubbleFixture() {
  const bubble = Fastify();
  servers.push(bubble);
  const state = {
    status: 200,
    owner: true,
    disabled: false,
    target: { type: 'system' } as { type: string; threadId?: string },
    authorizations: [] as (string | undefined)[],
  };
  bubble.get('/bubble/v1/auth/whoami', async (request, reply) => {
    state.authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== 'Bearer valid')
      return reply.code(401).send({ error: 'invalid' });
    if (state.status !== 200)
      return reply
        .code(state.status)
        .send({ error: 'private upstream detail' });
    return {
      principal: {
        principalId: 'alice',
        kind: 'user',
        displayName: 'Alice',
        ...(state.disabled ? { disabledAt: '2026-09-23T00:00:00Z' } : {}),
        secretExtra: 'must not escape',
      },
      grants: [
        { target: state.target, role: state.owner ? 'owner' : 'reader' },
      ],
    };
  });
  const origin = await bubble.listen({ port: 0, host: '127.0.0.1' });
  return {
    state,
    app: host(createBubbleIdentityService(`${origin}/bubble/`)),
    origin,
  };
}

describe('identity configuration', () => {
  it('selects local identity by default and validates the explicit Bubble mode', () => {
    expect(resolveIdentityConfig({})).toMatchObject({ provider: 'local' });
    expect(
      resolveIdentityConfig({
        HUABU_IDENTITY_PROVIDER: 'bubble',
        HUABU_BUBBLE_URL: 'https://bubble.example/prefix/',
      }),
    ).toEqual({ provider: 'bubble', baseUrl: 'https://bubble.example/prefix' });
  });
  it.each([
    { HUABU_IDENTITY_PROVIDER: 'typo' },
    { HUABU_BUBBLE_URL: 'https://bubble.example' },
    { HUABU_IDENTITY_PROVIDER: 'bubble' },
    {
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BUBBLE_URL: 'http://remote.example',
    },
    {
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BUBBLE_URL: 'https://user:password@bubble.example',
    },
    {
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BUBBLE_URL: 'https://bubble.example?token=secret',
    },
    {
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BUBBLE_URL: 'https://bubble.example',
      HUABU_BASIC_AUTH_USER: 'owner',
      HUABU_BASIC_AUTH_PASS: 'secret',
    },
  ])('rejects ambiguous or unsafe configuration: %j', (env) => {
    expect(() => resolveIdentityConfig(env)).toThrow();
  });
});

describe('local identity admission', () => {
  it('provides a stable local owner without a directory and rejects remote spoofing', async () => {
    const app = host(createLocalIdentityService());
    for (let i = 0; i < 2; i++) {
      const response = await app.inject('/api/identity');
      expect(response.json()).toEqual({
        provider: 'local',
        principal: {
          principalId: 'local-owner',
          kind: 'user',
          displayName: 'Local owner',
        },
        owner: true,
      });
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const remote = await app.inject({
      url: '/api/data',
      remoteAddress: '192.0.2.1',
      headers: {
        'x-forwarded-for': '127.0.0.1',
        'x-principal-id': 'local-owner',
      },
    });
    expect(remote.statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/data',
          headers: { authorization: 'Bearer unknown' },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('keeps Basic Auth mandatory even on loopback when configured', async () => {
    const app = host(
      createLocalIdentityService({ username: 'owner', password: 'secret' }),
    );
    expect((await app.inject('/api/settings')).statusCode).toBe(401);
    const response = await app.inject({
      url: '/api/settings',
      remoteAddress: '192.0.2.1',
      headers: {
        authorization: `Basic ${Buffer.from('owner:secret').toString('base64')}`,
      },
    });
    expect(response.statusCode).toBe(200);
  });
  it('retains RFS bootstrap and machine access without granting machine owner authority', async () => {
    const app = host(createLocalIdentityService());
    expect((await app.inject('/api/rfs/space/skill')).statusCode).toBe(200);
    expect((await app.inject('/api/rfs/space/content')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/rfs/space/skill',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    const headers = { authorization: 'Bearer machine-secret' };
    expect(
      (await app.inject({ url: '/api/rfs/space/content', headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: '/api/settings', headers })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'OPTIONS',
          url: '/api/data',
          remoteAddress: '192.0.2.1',
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('Bubble identity admission over HTTP', () => {
  it('ends an already-open HTTP stream when identity is revoked and releases streams on shutdown', async () => {
    const { state, origin } = await bubbleFixture();
    const streaming = Fastify();
    servers.push(streaming);
    registerIdentity(streaming, {
      service: createBubbleIdentityService(`${origin}/bubble`),
      getConnectionToken: () => undefined,
      revalidationIntervalMs: 20,
    });
    streaming.get('/api/events', (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.write('data: ready\n\n');
    });
    const hostOrigin = await streaming.listen({ port: 0, host: '127.0.0.1' });
    async function open() {
      const response = await fetch(`${hostOrigin}/api/events`, {
        headers: { authorization: 'Bearer valid' },
        signal: AbortSignal.timeout(3_000),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing stream');
      expect((await reader.read()).done).toBe(false);
      return reader;
    }
    const reader = await open();
    const started = performance.now();
    state.disabled = true;
    expect((await reader.read()).done).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(state.authorizations.length).toBeGreaterThan(1);
    state.disabled = false;
    const second = await open();
    const closed = second.read().catch(() => ({ done: true }));
    await streaming.close();
    expect((await closed).done).toBe(true);
  });

  it('preserves Bubble principal IDs and projects only Huabu identity fields', async () => {
    const { app, state } = await bubbleFixture();
    const response = await app.inject({
      url: '/api/identity',
      headers: { authorization: 'Bearer valid', 'x-principal-id': 'forged' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: 'bubble',
      principal: { principalId: 'alice', kind: 'user', displayName: 'Alice' },
      owner: true,
    });
    expect(state.authorizations).toEqual(['Bearer valid']);
    expect(
      (
        await app.inject({
          url: '/api/settings',
          remoteAddress: '192.0.2.1',
          headers: { authorization: 'Bearer valid' },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('never turns missing or invalid Bubble credentials into a local owner', async () => {
    const { app } = await bubbleFixture();
    expect((await app.inject('/api/settings')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/settings',
          headers: { authorization: 'Bearer invalid' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/settings',
          headers: { authorization: 'Basic b3duZXI6c2VjcmV0' },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('requires a system owner, not just a valid login or thread owner, for the shared Workspace', async () => {
    const { app, state } = await bubbleFixture();
    const headers = { authorization: 'Bearer valid' };
    state.target = { type: 'thread', threadId: 'some-thread' };
    expect(
      (await app.inject({ url: '/api/identity', headers })).json().owner,
    ).toBe(false);
    expect((await app.inject({ url: '/api/data', headers })).statusCode).toBe(
      403,
    );
    state.target = { type: 'system' };
    state.owner = false;
    expect(
      (await app.inject({ url: '/api/settings', headers })).statusCode,
    ).toBe(403);
  });
  it('revalidates grants and account status on every request', async () => {
    const { app, state } = await bubbleFixture();
    const request = {
      url: '/api/settings',
      headers: { authorization: 'Bearer valid' },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    state.owner = false;
    expect((await app.inject(request)).statusCode).toBe(403);
    state.owner = true;
    state.disabled = true;
    expect((await app.inject(request)).statusCode).toBe(403);
    state.disabled = false;
    state.status = 403;
    expect((await app.inject(request)).statusCode).toBe(403);
    state.status = 401;
    expect((await app.inject(request)).statusCode).toBe(401);
  });
  it('fails closed with a redacted service error when Bubble fails', async () => {
    const { app, state } = await bubbleFixture();
    state.status = 500;
    const response = await app.inject({
      url: '/api/settings',
      headers: { authorization: 'Bearer valid' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: 'IDENTITY_UNAVAILABLE',
      message: 'Identity service unavailable',
    });
  });
  it('does not follow upstream redirects with a user credential', async () => {
    const upstream = Fastify();
    servers.push(upstream);
    let followed = false;
    upstream.get('/v1/auth/whoami', (_request, reply) =>
      reply.redirect('/elsewhere'),
    );
    upstream.get('/elsewhere', () => {
      followed = true;
      return {};
    });
    const origin = await upstream.listen({ port: 0, host: '127.0.0.1' });
    const app = host(createBubbleIdentityService(origin));
    expect(
      (
        await app.inject({
          url: '/api/settings',
          headers: { authorization: 'Bearer valid' },
        })
      ).statusCode,
    ).toBe(503);
    expect(followed).toBe(false);
  });
  it('rejects malformed successful responses', async () => {
    const upstream = Fastify();
    servers.push(upstream);
    upstream.get('/v1/auth/whoami', () => ({
      principal: { principalId: 'alice' },
      grants: [],
    }));
    const origin = await upstream.listen({ port: 0, host: '127.0.0.1' });
    const app = host(createBubbleIdentityService(origin));
    expect(
      (
        await app.inject({
          url: '/api/identity',
          headers: { authorization: 'Bearer valid' },
        })
      ).statusCode,
    ).toBe(503);
  });
});
