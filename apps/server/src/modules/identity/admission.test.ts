// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { InMemoryBubbleStore } from '@octostaff/bubble';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openBubbleIdentity } from './bubble.js';
import { registerIdentity } from './http.js';
import peopleRoutes from './people.route.js';
import { createMemoryWorkspacePreferences } from './preferences.js';
import {
  signIn,
  signInAuthenticator,
} from '../../test-support/identity-provider.js';
import { getServerRecords } from '../storage/index.js';
import { getWorkspaceHandle } from '../workspace.js';

import type { ResourceDirectory } from './service.js';
import type { BubbleStore } from '@octostaff/bubble';
import type { FastifyInstance } from 'fastify';

type Authenticator = Parameters<typeof openBubbleIdentity>[0]['authenticator'];

/** The master key acting as `principalId`, which is never a sign-in. */
const as = (principalId: string) => ({
  authorization: 'Bearer master-secret',
  'x-bubble-principal-id': principalId,
});
const ADMIN = as('admin');

/** One existing Workspace, `shared`; personal Workspaces are made on demand. */
function directory(): ResourceDirectory {
  const workspaces = new Set(['shared']);
  const scope = (workspaceId: string) => ({
    handle: { workspaceId, name: workspaceId },
    path: null,
  });
  return {
    workspaceExists: async (id) => workspaces.has(id),
    spaceParent: async () => null,
    workspaceOfSpace: async () => null,
    openWorkspace: async (id) => (workspaces.has(id) ? scope(id) : null),
    defaultWorkspace: async () => scope('shared'),
    lockedWorkspace: async () => null,
    createWorkspace: async (name, adopt) => {
      const workspaceId = `personal-${workspaces.size}`;
      workspaces.add(workspaceId);
      await adopt(workspaceId);
      return { handle: { workspaceId, name }, path: null };
    },
  };
}

// Server records outlive a test in this file's data directory; each test
// starts from a deployment that never saved admission settings.
beforeEach(async () => {
  await getServerRecords().put(
    { owner: null, name: 'admission' },
    { automatic: false, blocked: {} },
  );
});

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

/**
 * A Bubble Server over `store`; a second host over the same store and server
 * records is that Server after a restart.
 */
async function host(
  store: BubbleStore = new InMemoryBubbleStore(),
  authenticator: Authenticator = signInAuthenticator(),
) {
  const bubble = await openBubbleIdentity({
    authenticator,
    owner: 'admin',
    store,
    preferences: createMemoryWorkspacePreferences(),
    resources: directory(),
  });
  // The member already admitted by hand.
  if (!(await store.principals.get('carol'))) {
    await store.principals.upsert({ principalId: 'carol', kind: 'user' });
    await store.grants.add({
      target: { type: 'system' },
      principalId: 'carol',
      role: 'member',
      grantedByPrincipalId: 'admin',
    });
  }
  const app = Fastify();
  servers.push(app);
  registerIdentity(app, {
    service: bubble.service,
    getConnectionToken: () => 'machine-secret',
  });
  await app.register(peopleRoutes, {
    prefix: '/api/people',
    service: bubble.service,
  });
  app.get('/api/workspace', async () => ({
    workspaceId: getWorkspaceHandle()?.workspaceId ?? null,
  }));

  const call = async (
    headers: Record<string, string>,
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({ method, url, headers, payload });
    return {
      status: response.statusCode,
      body: response.body ? response.json() : undefined,
    };
  };
  const identity = async (subject: string) =>
    (await call(signIn(subject), 'GET', '/api/identity')).body as {
      member: boolean;
      owner: boolean;
    };
  const setAutomatic = (automatic: boolean) =>
    call(ADMIN, 'PUT', '/api/people/admission', { automatic });
  const setMember = (principalId: string, member: boolean) =>
    call(ADMIN, 'PUT', `/api/people/${principalId}/member`, { member });
  const person = async (principalId: string) =>
    (
      (await call(ADMIN, 'GET', '/api/people')).body as Array<{
        principal: { principalId: string };
        member: boolean;
        admin: boolean;
        joinedAutomatically: boolean;
        blocked: boolean;
      }>
    ).find((p) => p.principal.principalId === principalId);
  const grants = async (principalId: string) =>
    (await store.grants.list({ principalId })).map(
      ({ target, role, grantedByPrincipalId }) => ({
        target,
        role,
        grantedByPrincipalId,
      }),
    );
  return {
    store,
    call,
    identity,
    setAutomatic,
    setMember,
    person,
    grants,
  };
}

describe('automatic admission', () => {
  it('is off by default, so a new sign-in waits for an administrator', async () => {
    const { call, identity, person, grants } = await host();
    expect((await call(ADMIN, 'GET', '/api/people/admission')).body).toEqual({
      automatic: false,
      providers: [],
    });

    expect(await identity('erin')).toMatchObject({
      member: false,
      owner: false,
    });
    expect((await call(signIn('erin'), 'GET', '/api/workspace')).status).toBe(
      403,
    );
    expect(await person('erin')).toMatchObject({
      member: false,
      joinedAutomatically: false,
      blocked: false,
    });
    expect(
      (await grants('erin')).filter((g) => g.target.type === 'system'),
    ).toEqual([]);
  });

  it('admits a first sign-in as an ordinary member with a personal Workspace only', async () => {
    const { call, identity, setAutomatic, person, grants } = await host();
    expect((await setAutomatic(true)).body).toEqual({
      automatic: true,
      providers: [],
    });

    expect(await identity('erin')).toMatchObject({
      member: true,
      owner: false,
    });
    const workspace = (await call(signIn('erin'), 'GET', '/api/workspace')).body
      .workspaceId as string;
    expect(workspace).toMatch(/^personal-/);
    // One system `member` with no grantor, and ownership of the Workspace
    // made for them; nothing on the system's owner role or `shared`.
    expect(await grants('erin')).toEqual(
      expect.arrayContaining([
        {
          target: { type: 'system' },
          role: 'member',
          grantedByPrincipalId: null,
        },
        {
          target: { type: 'huabu.workspace', id: workspace },
          role: 'huabu.workspace.owner',
          grantedByPrincipalId: 'erin',
        },
      ]),
    );
    expect(
      (await grants('erin')).filter(
        (g) =>
          (g.target.type === 'system' && g.role !== 'member') ||
          (g.target.type === 'huabu.workspace' && g.target.id === 'shared'),
      ),
    ).toEqual([]);
    expect(await person('erin')).toMatchObject({
      member: true,
      admin: false,
      joinedAutomatically: true,
      blocked: false,
    });
    // Someone an administrator admitted is not marked.
    expect(await person('carol')).toMatchObject({
      joinedAutomatically: false,
    });
  });

  it('admits only identity-provider sign-ins of enabled users', async () => {
    const { call, store, identity, setAutomatic, person } = await host();
    // Gina signed in while admission was manual, and was then disabled.
    expect(await identity('gina')).toMatchObject({ member: false });
    await store.principals.update('gina', {
      disabledAt: new Date().toISOString(),
    });
    // Hana signed in then too, and was given a system role with no Huabu
    // access.
    expect(await identity('hana')).toMatchObject({ member: false });
    await store.grants.add({
      target: { type: 'system' },
      principalId: 'hana',
      role: 'system_manager',
      grantedByPrincipalId: 'admin',
    });
    await setAutomatic(true);
    expect((await call(signIn('gina'), 'GET', '/api/identity')).status).toBe(
      403,
    );
    expect(await person('gina')).toMatchObject({ member: false });

    // The master key acting for someone is not their sign-in.
    expect(
      (await call(as('frank'), 'GET', '/api/identity')).body,
    ).toMatchObject({ member: false });
    // Nor is a bot's token: Bubble does not sign bots in through a provider,
    // and admission would not admit one if it did.
    await call(
      { authorization: 'Bearer idp-bot:robot' },
      'GET',
      '/api/identity',
    );
    expect((await person('robot'))?.member ?? false).toBe(false);
    // Nor an application signing in as itself with an Auth0
    // client-credentials token, which Bubble reports as a `user`.
    expect(
      (
        await call(
          { authorization: 'Bearer idp-app:reporting-job' },
          'GET',
          '/api/identity',
        )
      ).body,
    ).toMatchObject({ member: false });
    expect(await person('reporting-job')).toMatchObject({
      member: false,
    });

    // Any system grant that carries no Huabu access was an administrator's
    // choice; admission leaves it alone rather than adding `member`.
    expect(await identity('hana')).toMatchObject({ member: false });
    expect(await person('hana')).toMatchObject({
      member: false,
      joinedAutomatically: false,
    });
  });

  it('keeps a removed person out across sign-ins and a restart, until access is turned back on', async () => {
    const first = await host();
    await first.setAutomatic(true);
    expect(await first.identity('erin')).toMatchObject({ member: true });

    expect((await first.setMember('erin', false)).status).toBe(204);
    for (let i = 0; i < 3; i += 1)
      expect(await first.identity('erin')).toMatchObject({ member: false });
    expect(await first.person('erin')).toMatchObject({
      member: false,
      blocked: true,
      joinedAutomatically: false,
    });

    // The block is a server record, not process state.
    const restarted = await host(first.store);
    expect(await restarted.identity('erin')).toMatchObject({ member: false });
    expect(await restarted.person('erin')).toMatchObject({ blocked: true });

    expect((await restarted.setMember('erin', true)).status).toBe(204);
    expect(await restarted.identity('erin')).toMatchObject({ member: true });
    expect(await restarted.person('erin')).toMatchObject({
      member: true,
      blocked: false,
      // An administrator's grant now.
      joinedAutomatically: false,
    });
    const record = (await getServerRecords().get({
      owner: null,
      name: 'admission',
    })) as { blocked: Record<string, unknown> };
    expect(record.blocked).toEqual({});
  });

  it('blocks a removal made while admission is manual, so turning it on readmits nobody removed', async () => {
    const { identity, setAutomatic, setMember, person } = await host();
    expect(await identity('ivy')).toMatchObject({ member: false });
    await setMember('ivy', true);
    expect(await identity('ivy')).toMatchObject({ member: true });
    await setMember('ivy', false);
    expect(await person('ivy')).toMatchObject({ blocked: true });
    await setAutomatic(true);
    expect(await identity('ivy')).toMatchObject({ member: false });
    // Someone who simply never had access is admitted.
    expect(await identity('erin')).toMatchObject({ member: true });
  });

  it('readmits a person removed before blocks existed, unless an administrator blocks them first', async () => {
    const { store, identity, setAutomatic, setMember, person } = await host();
    // Alice and Bob were admitted and later removed by a Server without
    // admission blocks: the grant went, and nothing else was recorded.
    for (const principalId of ['alice', 'bob']) {
      expect(await identity(principalId)).toMatchObject({ member: false });
      await store.grants.add({
        target: { type: 'system' },
        principalId,
        role: 'member',
        grantedByPrincipalId: 'admin',
      });
      for (const row of await store.grants.list({
        target: { type: 'system' },
        principalId,
      }))
        await store.grants.remove(row.grantId);
      expect(await person(principalId)).toMatchObject({
        member: false,
        blocked: false,
      });
    }
    // The administrator keeps Bob out before turning admission on: admit,
    // then remove, which records a block.
    await setMember('bob', true);
    await setMember('bob', false);
    expect(await person('bob')).toMatchObject({ blocked: true });

    await setAutomatic(true);
    // Alice looks like anyone waiting, so her next sign-in admits her.
    expect(await identity('alice')).toMatchObject({ member: true });
    expect(await person('alice')).toMatchObject({ joinedAutomatically: true });
    expect(await identity('bob')).toMatchObject({ member: false });
    expect(await person('bob')).toMatchObject({
      member: false,
      blocked: true,
    });
  });

  it('keeps everyone already admitted when it is turned off', async () => {
    const { identity, setAutomatic, person } = await host();
    await setAutomatic(true);
    expect(await identity('erin')).toMatchObject({ member: true });
    expect((await setAutomatic(false)).body).toMatchObject({
      automatic: false,
    });
    expect(await identity('erin')).toMatchObject({ member: true });
    expect(await person('erin')).toMatchObject({ joinedAutomatically: true });
    // But nobody new is admitted.
    expect(await identity('hal')).toMatchObject({ member: false });
  });

  it('grants once for concurrent first requests, and never readmits past a racing removal', async () => {
    const { store, identity, setAutomatic, setMember } = await host();
    await setAutomatic(true);
    const first = await Promise.all(
      Array.from({ length: 8 }, () => identity('erin')),
    );
    expect(first.every((answer) => answer.member)).toBe(true);
    const members = async () =>
      (
        await store.grants.list({
          target: { type: 'system' },
          principalId: 'erin',
        })
      ).filter((grant) => grant.role === 'member');
    expect(await members()).toHaveLength(1);

    // Sign-ins racing a removal: whichever order they run in, once the
    // removal has returned they are out, and stay out.
    const before = Array.from({ length: 8 }, () => identity('erin'));
    const removed = setMember('erin', false);
    const after = Array.from({ length: 8 }, () => identity('erin'));
    await Promise.all([...before, removed, ...after]);
    expect((await removed).status).toBe(204);
    expect(await members()).toEqual([]);
    expect(await identity('erin')).toMatchObject({ member: false });

    // The same race for someone waiting, whose first admission and removal
    // both happen now: no admission may land after the removal.
    for (let round = 0; round < 10; round += 1) {
      const subject = `waiting-${round}`;
      await setAutomatic(false);
      expect(await identity(subject)).toMatchObject({ member: false });
      await setAutomatic(true);
      const signIns = Array.from({ length: 4 }, () => identity(subject));
      const removal = setMember(subject, false);
      await Promise.all([...signIns, removal, identity(subject)]);
      expect(
        (
          await store.grants.list({
            target: { type: 'system' },
            principalId: subject,
          })
        ).map((grant) => grant.role),
        subject,
      ).toEqual([]);
    }
  });

  it('admits nobody while its record is damaged, and still answers who is signed in', async () => {
    const { identity, setAutomatic } = await host();
    await setAutomatic(true);
    await getServerRecords().put(
      { owner: null, name: 'admission' },
      { automatic: 'yes' },
    );
    expect(await identity('erin')).toMatchObject({ member: false });
  });

  it('keeps People working when its record is damaged, except removing access', async () => {
    const { store, call, identity, setMember } = await host();
    expect(await identity('erin')).toMatchObject({ member: false });
    await getServerRecords().put(
      { owner: null, name: 'admission' },
      { automatic: 'yes' },
    );
    const memberRoles = async (principalId: string) =>
      (await store.grants.list({ target: { type: 'system' }, principalId }))
        .map((grant) => grant.role)
        .filter((role) => role === 'member');
    // Admitting needs no block cleared to stand.
    expect((await setMember('erin', true)).status).toBe(204);
    expect(await memberRoles('erin')).toEqual(['member']);
    // Removing cannot record its block, so it fails with the grant in place.
    expect((await setMember('carol', false)).status).toBe(500);
    expect(await memberRoles('carol')).toEqual(['member']);
    // A lost device's credentials can still be reset.
    expect(
      (await call(ADMIN, 'POST', '/api/people/carol/agent-credentials/reset'))
        .status,
    ).toBe(204);
  });

  it('keeps the block when an administrator’s grant fails, until a retry lands', async () => {
    const { store, identity, setAutomatic, setMember, person } = await host();
    expect(await identity('erin')).toMatchObject({ member: false });
    expect((await setMember('erin', true)).status).toBe(204);
    expect((await setMember('erin', false)).status).toBe(204);
    await setAutomatic(true);

    const add = store.grants.add.bind(store.grants);
    store.grants.add = () => Promise.reject(new Error('Bubble unavailable'));
    expect((await setMember('erin', true)).status).toBe(500);
    store.grants.add = add;
    expect(await person('erin')).toMatchObject({
      member: false,
      blocked: true,
    });
    expect(await identity('erin')).toMatchObject({ member: false });

    expect((await setMember('erin', true)).status).toBe(204);
    expect(await person('erin')).toMatchObject({
      member: true,
      blocked: false,
    });
  });

  it('names the configured providers it applies to', async () => {
    const { call } = await host(new InMemoryBubbleStore(), [
      { driver: 'local-token' },
      { driver: 'entra', tenantId: 'contoso-tenant', clientId: 'huabu' },
      {
        driver: 'auth0',
        domain: 'contoso.auth0.example',
        audience: 'https://huabu.example/api',
      },
      {
        driver: 'master-key',
        masterKey: 'master-secret',
        defaultPrincipalId: 'admin',
      },
    ]);
    expect((await call(ADMIN, 'GET', '/api/people/admission')).body).toEqual({
      automatic: false,
      providers: ['entra', 'auth0'],
    });
  });

  it('is an administrator’s setting alone', async () => {
    const { call } = await host();
    const carol = as('carol');
    expect((await call(carol, 'GET', '/api/people/admission')).status).toBe(
      403,
    );
    expect(
      (
        await call(carol, 'PUT', '/api/people/admission', {
          automatic: true,
        })
      ).status,
    ).toBe(403);
    // Someone not admitted reaches no People route at all.
    expect(
      (await call(signIn('erin'), 'GET', '/api/people/admission')).status,
    ).toBe(403);
    expect(
      (await call(ADMIN, 'PUT', '/api/people/admission', { automatic: 'on' }))
        .status,
    ).toBe(400);
    expect((await call(ADMIN, 'GET', '/api/people/admission')).body).toEqual({
      automatic: false,
      providers: [],
    });
  });
});
