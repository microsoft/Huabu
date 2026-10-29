// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash } from 'node:crypto';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { openBubbleIdentity } from './bubble.js';
import { registerIdentity } from './http.js';
import { getRequestIdentity } from './request.js';
import { isOwnerRequest } from '../security/owner.js';
import { registerSpaceAccess } from '../security/space-access.js';

import type { HuabuResource, ResourceDirectory } from './service.js';
import type { BubbleStore } from '@octostaff/bubble';
import type { AuthzTarget, Role } from '@octostaff/sdk';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AddressInfo } from 'node:net';

type Authenticator = Parameters<typeof openBubbleIdentity>[0]['authenticator'];

const MASTER = { authorization: 'Bearer master-secret' };
/** The master key acting as another principal, as Bubble's own routes allow. */
const as = (principalId: string) => ({
  ...MASTER,
  'x-bubble-principal-id': principalId,
});
const AUTHENTICATORS: Authenticator = [
  { driver: 'local-token' },
  {
    driver: 'master-key',
    masterKey: 'master-secret',
    defaultPrincipalId: 'admin',
  },
];

const SYSTEM = { type: 'system' } as const;
/** Bubble keeps one row per role; these grant or drop every role on a target. */
async function grant(
  store: BubbleStore,
  principalId: string,
  role: Role,
  target: AuthzTarget = SYSTEM,
) {
  await store.grants.add({
    target,
    principalId,
    role,
    grantedByPrincipalId: null,
  });
}
async function revokeAll(
  store: BubbleStore,
  principalId: string,
  target: AuthzTarget = SYSTEM,
) {
  for (const row of await store.grants.list({ target, principalId }))
    await store.grants.remove(row.grantId);
}

/** Workspace `w1` holds Spaces `a` and `b`, `a` holds `a1`; `w2` holds `c`. */
const PARENTS: Record<string, HuabuResource> = {
  a: { type: 'workspace', id: 'w1' },
  a1: { type: 'space', id: 'a' },
  b: { type: 'workspace', id: 'w1' },
  c: { type: 'workspace', id: 'w2' },
};
const RESOURCES: ResourceDirectory = {
  workspaceExists: async (id) => id === 'w1' || id === 'w2',
  spaceParent: async (id) => PARENTS[id] ?? null,
};

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

/** The composition app.ts performs, over an in-memory store. */
async function host(
  options: {
    authenticator?: Authenticator;
    owner?: string;
    revalidationIntervalMs?: number;
    secureOrigin?: boolean;
  } = {},
) {
  const store = new InMemoryBubbleStore();
  const lookups: string[] = [];
  const bubble = await openBubbleIdentity({
    authenticator: options.authenticator ?? AUTHENTICATORS,
    owner: 'owner' in options ? options.owner : 'admin',
    store,
    resources: {
      ...RESOURCES,
      spaceParent: async (id) => {
        lookups.push(id);
        return RESOURCES.spaceParent(id);
      },
    },
  });
  const app = Fastify();
  servers.push(app);
  registerIdentity(app, {
    service: bubble.service,
    getConnectionToken: () => 'machine-secret',
    revalidationIntervalMs: options.revalidationIntervalMs,
    secureOrigin: options.secureOrigin,
  });
  void app.register(bubble.plugin, { prefix: '/bubble' });
  registerSpaceAccess(app);
  app.get('/', { config: { identity: 'shell' } }, async () => 'shell');
  app.get('/api/data', async () => ({ private: true }));
  // Answers what the caller may do with each Space, and claims one on POST.
  app.get('/api/access', async (request) => {
    const { access } = getRequestIdentity(request)!;
    const levels = async (id: string) =>
      (
        await Promise.all(
          (['read', 'write'] as const).map(async (level) =>
            (await access.can(level, { type: 'space', id })) ? level : '',
          ),
        )
      ).join('');
    return Object.fromEntries(
      await Promise.all(
        ['a', 'a1', 'b', 'c', 'missing'].map(async (id) => [
          id,
          await levels(id),
        ]),
      ),
    );
  });
  app.post<{ Params: { id: string } }>('/api/claim/:id', async (request) => {
    await getRequestIdentity(request)!.access.claim({
      type: 'space',
      id: request.params.id,
    });
    return {};
  });
  app.get('/api/settings', async (request, reply) =>
    isOwnerRequest(request) ? { private: true } : reply.code(403).send({}),
  );
  const events = (_request: unknown, reply: FastifyReply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
    reply.raw.write('data: ready\n\n');
  };
  app.get('/api/events', events);
  app.get('/api/canvas/:canvasId/events', events);
  return { app, store, lookups };
}

/** Whether a WebSocket on `path` opens and, when asked, carries a clean reply. */
function connects(
  port: number,
  path: string,
  reply?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const settle = (ok: boolean) => {
      socket.close();
      resolve(ok);
    };
    socket.onopen = () => (reply ? socket.send('ping') : settle(true));
    socket.onmessage = (event) => settle(event.data === reply);
    socket.onerror = () => settle(false);
    socket.onclose = () => settle(false);
  });
}

describe('Bubble identity', () => {
  it('admits the provisioned owner by master key, and other principals only as themselves', async () => {
    const { app } = await host();
    const identity = await app.inject({
      url: '/api/identity',
      headers: MASTER,
    });
    expect(identity.json()).toEqual({
      provider: 'bubble',
      principal: { principalId: 'admin', kind: 'user' },
      member: true,
      owner: true,
    });
    expect(
      (await app.inject({ url: '/api/data', headers: MASTER })).statusCode,
    ).toBe(200);

    // The master-key principal override resolves as it does on Bubble's routes.
    for (const url of ['/api/identity', '/bubble/v1/auth/whoami']) {
      const response = await app.inject({ url, headers: as('bob') });
      expect(response.json().principal.principalId).toBe('bob');
    }
    const denied = await app.inject({ url: '/api/data', headers: as('bob') });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'ACCESS_REQUIRED' });
  });

  it('lets a system member use Huabu without owner authority, and no other role', async () => {
    const { app, store } = await host();
    const carol = { headers: as('carol') };
    const identity = async () =>
      (await app.inject({ url: '/api/identity', ...carol })).json();
    const statuses = async () =>
      Promise.all(
        ['/api/data', '/api/settings'].map(
          async (url) => (await app.inject({ url, ...carol })).statusCode,
        ),
      );
    expect(await statuses()).toEqual([403, 403]);

    await grant(store, 'carol', 'member');
    expect(await identity()).toMatchObject({ member: true, owner: false });
    expect(await statuses()).toEqual([200, 403]);

    // Roles carry Huabu access only on the system target, and only these two.
    await revokeAll(store, 'carol');
    await grant(store, 'carol', 'system_manager');
    expect(await identity()).toMatchObject({ member: false, owner: false });
    await grant(store, 'carol', 'owner');
    expect(await statuses()).toEqual([200, 200]);
  });

  it('accepts a bot local token minted through the mounted Bubble API until it is revoked', async () => {
    const { app } = await host();
    const admin = async (
      method: 'POST' | 'PUT' | 'DELETE',
      url: string,
      payload?: object,
    ) =>
      app.inject({ method, url: `/bubble/v1${url}`, headers: MASTER, payload });
    // Bubble issues local tokens to bots; the owner creates one and its token.
    const created = await admin('POST', '/principals', {
      principalId: 'ci-bot',
      kind: 'bot',
    });
    expect(created.statusCode).toBe(200);
    const minted = await admin('POST', '/principals/ci-bot/tokens', {});
    expect(minted.statusCode).toBe(200);
    const { token, tokenId } = (
      minted.json() as { token: { token: string; tokenId: string } }
    ).token;
    const local = { authorization: `Bearer ${token}` };

    // A valid token is a login, not Huabu access, until ownership is granted.
    expect(
      (await app.inject({ url: '/api/identity', headers: local })).json(),
    ).toMatchObject({
      principal: { principalId: 'ci-bot', kind: 'bot' },
      owner: false,
    });
    expect(
      (await app.inject({ url: '/api/data', headers: local })).statusCode,
    ).toBe(403);
    const granted = await admin('POST', '/grants', {
      target: { type: 'system' },
      principalId: 'ci-bot',
      role: 'owner',
    });
    expect(granted.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/data', headers: local })).statusCode,
    ).toBe(200);

    const revoked = await admin(
      'DELETE',
      `/principals/ci-bot/tokens/${tokenId}`,
    );
    expect(revoked.statusCode).toBe(204);
    expect(
      (await app.inject({ url: '/api/data', headers: local })).statusCode,
    ).toBe(401);
  });

  it('leaves admission of its own routes to Bubble, and of everything else to Huabu', async () => {
    const { app } = await host();
    // Clients discover how to log in before they hold a credential.
    const authenticators = await app.inject('/bubble/v1/auth/authenticators');
    expect(authenticators.statusCode).toBe(200);
    expect(JSON.stringify(authenticators.json())).toContain('local-token');

    // Bubble, not Huabu, refuses: the Agentlet machine token is no Bubble credential.
    for (const headers of [{}, { authorization: 'Bearer machine-secret' }]) {
      const whoami = await app.inject({
        url: '/bubble/v1/auth/whoami',
        headers,
      });
      expect(whoami.statusCode).toBe(401);
      expect(whoami.json()).not.toMatchObject({ code: 'IDENTITY_REQUIRED' });
    }
    // An unrouted path under the prefix is not Bubble's to exempt.
    const unknown = await app.inject('/bubble/v1/no-such-route');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ code: 'IDENTITY_REQUIRED' });
  });

  it('never turns missing or rejected credentials into a local owner', async () => {
    const { app } = await host();
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

  it('grants nothing without a provisioned owner', async () => {
    const { app } = await host({ owner: undefined });
    const identity = await app.inject({
      url: '/api/identity',
      headers: MASTER,
    });
    expect(identity.json()).toMatchObject({ owner: false });
    expect(
      (await app.inject({ url: '/api/data', headers: MASTER })).statusCode,
    ).toBe(403);
  });

  it('applies grant revocation and account disablement on the next request', async () => {
    const { app, store } = await host();
    const alice = { url: '/api/data', headers: as('alice') };
    expect((await app.inject(alice)).statusCode).toBe(403);
    await grant(store, 'alice', 'owner');
    expect((await app.inject(alice)).statusCode).toBe(200);
    await revokeAll(store, 'alice');
    expect((await app.inject(alice)).statusCode).toBe(403);

    await grant(store, 'alice', 'owner');
    await store.principals.update('alice', {
      disabledAt: '2026-09-29T00:00:00Z',
    });
    const disabled = await app.inject(alice);
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toEqual({
      message: 'Identity access denied',
      code: 'IDENTITY_FORBIDDEN',
    });
  });

  it('ends an open HTTP stream when its identity is revoked, and on shutdown', async () => {
    const { app, store } = await host({ revalidationIntervalMs: 20 });
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    async function open() {
      const response = await fetch(`${origin}/api/events`, {
        headers: MASTER,
        signal: AbortSignal.timeout(3_000),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing stream');
      expect((await reader.read()).done).toBe(false);
      return reader;
    }
    const reader = await open();
    await revokeAll(store, 'admin');
    expect((await reader.read()).done).toBe(true);

    await grant(store, 'admin', 'owner');
    const second = await open();
    const closed = second.read().catch(() => ({ done: true }));
    await app.close();
    expect((await closed).done).toBe(true);
  });

  it('ends an open Space stream once the caller loses that Space', async () => {
    const { app, store } = await host({ revalidationIntervalMs: 20 });
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    await grant(store, 'carol', 'member');
    const space = { type: 'huabu.space', id: 'b' } as const;
    await grant(store, 'carol', 'huabu.space.owner', space);
    const response = await fetch(`${origin}/api/canvas/b/events`, {
      headers: as('carol'),
      signal: AbortSignal.timeout(3_000),
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    // Still a member, and still able to make other requests.
    await revokeAll(store, 'carol', space);
    expect((await reader.read()).done).toBe(true);
    expect(
      (await app.inject({ url: '/api/canvas/b/events', headers: as('carol') }))
        .statusCode,
    ).toBe(404);
  });

  it('answers every check in a request from one policy scope', async () => {
    const { app, lookups } = await host();
    await app.inject({ url: '/api/access', headers: MASTER });
    // Ten questions about five Spaces, each Space resolved once.
    expect(lookups.filter((id) => id === 'a')).toHaveLength(1);
  });

  it('serves the application shell to a browser that has not signed in', async () => {
    const { app } = await host();
    const shell = await app.inject('/');
    expect([shell.statusCode, shell.body]).toEqual([200, 'shell']);
    expect((await app.inject('/api/data')).statusCode).toBe(401);
  });

  it('lets a member reach only the Spaces they own, and a Workspace owner every Space in it', async () => {
    const { app, store } = await host();
    const access = async (principalId: string) =>
      (
        await app.inject({ url: '/api/access', headers: as(principalId) })
      ).json();
    for (const principalId of ['carol', 'dave'])
      await grant(store, principalId, 'member');
    const none = { a: '', a1: '', b: '', c: '', missing: '' };
    expect(await access('carol')).toEqual(none);

    // Creating a Space makes its creator the owner of it and the Spaces inside
    // it, and nobody else.
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/claim/a',
      headers: as('carol'),
    });
    expect(claimed.statusCode).toBe(200);
    expect(await access('carol')).toEqual({
      ...none,
      a: 'readwrite',
      a1: 'readwrite',
    });
    expect(await access('dave')).toEqual(none);

    // A Workspace owner reaches its Spaces, not another Workspace's.
    await grant(store, 'dave', 'huabu.workspace.owner', {
      type: 'huabu.workspace',
      id: 'w1',
    });
    expect(await access('dave')).toEqual({
      ...none,
      a: 'readwrite',
      a1: 'readwrite',
      b: 'readwrite',
    });

    // The system owner reaches every Space that exists.
    expect(await access('admin')).toEqual({
      a: 'readwrite',
      a1: 'readwrite',
      b: 'readwrite',
      c: 'readwrite',
      missing: '',
    });
  });

  it('leaves granting Space ownership to system owners', async () => {
    const { app, store } = await host();
    await grant(store, 'carol', 'member');
    await app.inject({
      method: 'POST',
      url: '/api/claim/a',
      headers: as('carol'),
    });
    const share = (principalId: string) =>
      app.inject({
        method: 'POST',
        url: '/bubble/v1/grants',
        headers: as(principalId),
        payload: {
          target: { type: 'huabu.space', id: 'a' },
          principalId: 'dave',
          role: 'huabu.space.owner',
        },
      });
    expect((await share('carol')).statusCode).toBe(403);
    expect((await share('admin')).statusCode).toBeLessThan(300);
  });

  it('carries a validated Bearer credential in an HttpOnly session cookie', async () => {
    const { app } = await host();
    // Only a credential Bubble accepts becomes a session.
    const refused = await app.inject({
      method: 'POST',
      url: '/api/identity/session',
      headers: { authorization: 'Bearer machine-secret' },
    });
    expect(refused.statusCode).toBe(400);

    const started = await app.inject({
      method: 'POST',
      url: '/api/identity/session',
      headers: MASTER,
    });
    expect(started.statusCode).toBe(204);
    const cookie = String(started.headers['set-cookie']);
    expect(cookie).toMatch(/^huabu_session=master-secret; /);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');

    const session = { cookie: cookie.split(';', 1)[0] };
    expect(
      (await app.inject({ url: '/api/data', headers: session })).statusCode,
    ).toBe(200);
    // An explicit header still wins over the cookie.
    expect(
      (
        await app.inject({
          url: '/api/data',
          headers: { ...session, authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);

    // Ending a session needs no credential and expires the cookie.
    const ended = await app.inject({
      method: 'DELETE',
      url: '/api/identity/session',
    });
    expect(ended.statusCode).toBe(204);
    expect(String(ended.headers['set-cookie'])).toMatch(
      /^huabu_session=; .*Max-Age=0/,
    );
  });

  it('marks the session cookie Secure behind an HTTPS origin', async () => {
    const { app } = await host({ secureOrigin: true });
    const started = await app.inject({
      method: 'POST',
      url: '/api/identity/session',
      headers: MASTER,
    });
    expect(String(started.headers['set-cookie'])).toContain('; Secure');
  });

  it('fails closed with a redacted error when the verifier fails', async () => {
    const { app } = await host({
      authenticator: {
        authenticate() {
          throw new Error('jwks fetch failed: private detail');
        },
      },
    });
    const response = await app.inject({
      url: '/api/identity',
      headers: MASTER,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      message: 'Identity service unavailable',
      code: 'IDENTITY_UNAVAILABLE',
    });
  });

  it('rejects an authenticator list Bubble does not accept', async () => {
    await expect(
      openBubbleIdentity({
        authenticator: [{ driver: 'no-such-driver' }] as never,
        store: new InMemoryBubbleStore(),
        resources: RESOURCES,
      }),
    ).rejects.toThrow();
  });

  it('upgrades its own WebSocket without answering upgrades owned by another listener', async () => {
    const { app } = await host();
    // Stands in for the Agentlet gateway, which upgrades outside Fastify.
    app.server.on('upgrade', (request, socket) => {
      if (request.url !== '/api/acp/agent') return;
      const accept = createHash('sha1')
        .update(
          `${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
        )
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // One unmasked text frame; bytes Fastify wrote first would corrupt it.
      socket.once('data', () => socket.end(Buffer.from([0x81, 2, 0x6f, 0x6b])));
      socket.resume();
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    expect(await connects(port, '/api/acp/agent', 'ok')).toBe(true);
    expect(await connects(port, '/bubble/v1/ws')).toBe(true);
  });
});
