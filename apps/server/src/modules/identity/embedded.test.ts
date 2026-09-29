// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  bubblePlugin,
  createBubbleRuntime,
  InMemoryBubbleStore,
} from '@octostaff/bubble';
import { BubbleErrorCode, BubbleProtocolError } from '@octostaff/sdk';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createEmbeddedBubbleIdentityService } from './embedded.js';
import { registerIdentity } from './http.js';

import type { BubbleRuntime } from '@octostaff/bubble';
import type { BubbleAuthenticator } from '@octostaff/sdk';
import type { FastifyInstance } from 'fastify';

const ISSUER = 'https://login.example/';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Stands in for an OIDC verifier until Bubble exports its production ones. */
const verifier: BubbleAuthenticator & { failing: boolean } = {
  failing: false,
  authenticate(request) {
    if (this.failing) throw new Error('jwks fetch failed: private detail');
    const token = /^Bearer (\S+)$/.exec(request.authorization ?? '')?.[1];
    const principalId = token?.startsWith('token-')
      ? token.slice('token-'.length)
      : undefined;
    if (!token || !principalId)
      throw new BubbleProtocolError(
        BubbleErrorCode.Unauthenticated,
        'Missing token.',
      );
    return {
      principalId,
      kind: 'user',
      displayName: principalId === 'alice' ? 'Alice' : 'Bob',
      issuer: ISSUER,
      subject: `sub|${principalId}`,
      token,
    };
  },
};

async function embedded(): Promise<{
  app: FastifyInstance;
  runtime: BubbleRuntime;
}> {
  verifier.failing = false;
  const store = new InMemoryBubbleStore();
  const runtime = await createBubbleRuntime({
    store,
    authenticator: verifier,
    autoGrantFirstUserSystemOwner: false,
  });
  const app = Fastify();
  registerIdentity(app, {
    service: createEmbeddedBubbleIdentityService(runtime),
    getConnectionToken: () => 'machine-secret',
  });
  app.get('/api/data', async () => ({ private: true }));
  await app.register(bubblePlugin(runtime), { prefix: '/bubble' });
  await app.ready();
  await runtime.start();
  // Host shutdown order: stop serving, stop Bubble, then release storage.
  cleanups.push(async () => {
    await app.close();
    await runtime.stop();
    await store.close();
  });
  return { app, runtime };
}

async function grantSystemOwner(runtime: BubbleRuntime, principalId: string) {
  await runtime.store.grants.grant({ type: 'system' }, principalId, 'owner');
}

const as = (principalId: string) => ({
  authorization: `Bearer token-${principalId}`,
});

describe('embedded Bubble identity admission', () => {
  it('resolves one principal through Huabu and the mounted Bubble API', async () => {
    const { app, runtime } = await embedded();
    // Registration happens on first use, then an administrator grants owner.
    const first = await app.inject({
      url: '/api/identity',
      headers: as('alice'),
    });
    expect(first.json()).toMatchObject({ owner: false });
    await grantSystemOwner(runtime, 'alice');

    const identity = await app.inject({
      url: '/api/identity',
      headers: as('alice'),
    });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toEqual({
      provider: 'bubble',
      principal: { principalId: 'alice', kind: 'user', displayName: 'Alice' },
      owner: true,
    });

    const whoami = await app.inject({
      url: '/bubble/v1/auth/whoami',
      headers: as('alice'),
    });
    expect(whoami.statusCode).toBe(200);
    expect(whoami.json().principal.principalId).toBe('alice');
    expect(
      (await app.inject({ url: '/api/data', headers: as('alice') })).json(),
    ).toEqual({ private: true });
  });

  it('does not auto-grant the first user or treat a login as Workspace access', async () => {
    const { app } = await embedded();
    const identity = await app.inject({
      url: '/api/identity',
      headers: as('bob'),
    });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toMatchObject({
      principal: { principalId: 'bob' },
      owner: false,
    });
    const data = await app.inject({ url: '/api/data', headers: as('bob') });
    expect(data.statusCode).toBe(403);
    expect(data.json()).toMatchObject({ code: 'OWNER_REQUIRED' });
  });

  it('never turns missing or rejected credentials into a local owner', async () => {
    const { app } = await embedded();
    for (const headers of [
      {},
      { authorization: 'Bearer nope' },
      { authorization: 'Basic YTpi' },
    ]) {
      const response = await app.inject({
        url: '/api/data',
        headers,
        remoteAddress: '127.0.0.1',
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="Huabu"');
    }
  });

  it('applies account disablement and grant revocation on the next request', async () => {
    const { app, runtime } = await embedded();
    await app.inject({ url: '/api/identity', headers: as('alice') });
    await grantSystemOwner(runtime, 'alice');
    expect(
      (await app.inject({ url: '/api/data', headers: as('alice') })).statusCode,
    ).toBe(200);

    await runtime.store.grants.revoke({ type: 'system' }, 'alice');
    expect(
      (await app.inject({ url: '/api/data', headers: as('alice') })).statusCode,
    ).toBe(403);

    await grantSystemOwner(runtime, 'alice');
    await runtime.store.principals.update('alice', {
      disabledAt: '2026-09-29T00:00:00Z',
    });
    const disabled = await app.inject({
      url: '/api/identity',
      headers: as('alice'),
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toEqual({
      message: 'Identity access denied',
      code: 'IDENTITY_FORBIDDEN',
    });
  });

  it('fails closed with a redacted error when the verifier fails', async () => {
    const { app } = await embedded();
    verifier.failing = true;
    const response = await app.inject({
      url: '/api/identity',
      headers: as('alice'),
      remoteAddress: '127.0.0.1',
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private detail');
    expect(response.json()).toEqual({
      message: 'Identity service unavailable',
      code: 'IDENTITY_UNAVAILABLE',
    });
  });
});
