// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

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

const POSTGRES = {
  HUABU_STRUCTURED_BACKEND: 'postgres',
  HUABU_POSTGRES_URL: 'postgres://huabu@db.example/huabu',
};

describe('identity configuration', () => {
  it('selects local identity by default', () => {
    expect(resolveIdentityConfig({})).toMatchObject({ provider: 'local' });
  });
  it('selects Bubble with local tokens by default, or a configured authenticator list', () => {
    expect(
      resolveIdentityConfig({ ...POSTGRES, HUABU_IDENTITY_PROVIDER: 'bubble' }),
    ).toEqual({
      provider: 'bubble',
      authenticators: [{ driver: 'local-token' }],
      postgresUrl: POSTGRES.HUABU_POSTGRES_URL,
    });
    expect(
      resolveIdentityConfig({
        ...POSTGRES,
        HUABU_IDENTITY_PROVIDER: 'bubble',
        HUABU_BUBBLE_AUTH:
          '[{"driver":"local-token"},{"driver":"master-key","masterKeyEnvVar":"HUABU_BUBBLE_MASTER_KEY","defaultPrincipalId":"admin"}]',
        HUABU_BUBBLE_OWNER: ' admin ',
      }),
    ).toMatchObject({
      authenticators: [
        { driver: 'local-token' },
        {
          driver: 'master-key',
          masterKeyEnvVar: 'HUABU_BUBBLE_MASTER_KEY',
          defaultPrincipalId: 'admin',
        },
      ],
      owner: 'admin',
    });
  });
  it('keeps Bubble independent of the backend holding Huabu content', () => {
    expect(
      resolveIdentityConfig({
        HUABU_IDENTITY_PROVIDER: 'bubble',
        HUABU_STRUCTURED_BACKEND: 'sqlite',
        HUABU_POSTGRES_URL: POSTGRES.HUABU_POSTGRES_URL,
      }),
    ).toMatchObject({ provider: 'bubble' });
  });
  it.each([
    { HUABU_IDENTITY_PROVIDER: 'typo' },
    { HUABU_BASIC_AUTH_USER: 'owner' },
    // Bubble keeps its records only in Postgres.
    { HUABU_IDENTITY_PROVIDER: 'bubble' },
    { HUABU_IDENTITY_PROVIDER: 'bubble', HUABU_STRUCTURED_BACKEND: 'postgres' },
    { ...POSTGRES, HUABU_IDENTITY_PROVIDER: 'bubble', HUABU_BUBBLE_AUTH: '[]' },
    {
      ...POSTGRES,
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BUBBLE_AUTH: '{"driver":"local-token"}',
    },
    {
      ...POSTGRES,
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BUBBLE_AUTH: '[{"masterKey":"x"}]',
    },
    // A master key agents could inherit: Bubble's default variable, or a
    // named one outside the HUABU_ namespace the Agentlet strips.
    {
      ...POSTGRES,
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BUBBLE_AUTH: '[{"driver":"master-key"}]',
    },
    {
      ...POSTGRES,
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BUBBLE_AUTH: '[{"driver":"master-key","masterKeyEnvVar":"MY_KEY"}]',
    },
    { ...POSTGRES, HUABU_IDENTITY_PROVIDER: 'bubble', BUBBLE_MASTER_KEY: 'k' },
    {
      ...POSTGRES,
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_BASIC_AUTH_USER: 'owner',
      HUABU_BASIC_AUTH_PASS: 'secret',
    },
  ])('rejects ambiguous or unsupported configuration: %j', (env) => {
    expect(() => resolveIdentityConfig(env)).toThrow();
  });
});

describe('local identity admission', () => {
  it('provides a stable local owner over loopback and no owner to remote spoofing', async () => {
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
        member: true,
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
    // Without Basic Auth every caller is admitted, as before identity
    // existed; only a loopback peer is the owner.
    expect(remote.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/settings',
          remoteAddress: '192.0.2.1',
          headers: { 'x-forwarded-for': '127.0.0.1' },
        })
      ).statusCode,
    ).toBe(403);
    // An unrelated credential, such as one a proxy adds, changes nothing.
    const proxied = await app.inject({
      url: '/api/settings',
      headers: { authorization: 'Bearer unrelated-proxy-token' },
    });
    expect(proxied.statusCode).toBe(200);
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

  it('admits credential-free remote callers as owner only when login is disabled', async () => {
    const remote = { url: '/api/settings', remoteAddress: '192.0.2.1' };
    expect(
      (await host(createLocalIdentityService()).inject(remote)).statusCode,
    ).toBe(403);
    const open = host(createLocalIdentityService({ open: true }));
    expect((await open.inject(remote)).statusCode).toBe(200);
    expect(
      (
        await open.inject({
          ...remote,
          headers: { authorization: 'Bearer guess' },
        })
      ).statusCode,
    ).toBe(200);
    // Disabling login never opens the machine surface.
    expect(
      (
        await open.inject({
          url: '/api/rfs/space/content',
          remoteAddress: '192.0.2.1',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('retains RFS bootstrap, and machine access with the local owner rule', async () => {
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
    // As every local caller, the machine is the owner over loopback only.
    expect(
      (await app.inject({ url: '/api/settings', headers })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/settings',
          remoteAddress: '192.0.2.1',
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/rfs/space/content',
          headers: { authorization: 'Bearer unrelated-proxy-token' },
        })
      ).statusCode,
    ).toBe(401);
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
