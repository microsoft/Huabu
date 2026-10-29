// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { EventEmitter } from 'node:events';

import websocket from '@fastify/websocket';
import { bubblePlugin, createBubbleRuntime } from '@octostaff/bubble';
import {
  PostgresBubbleStore,
  PostgresConnection,
} from '@octostaff/bubble/postgres';
import {
  authenticateBubbleRequest,
  bubbleAuthContextToPrincipal,
  BubbleErrorCode,
  isBubbleProtocolError,
} from '@octostaff/sdk';

import { identityPrincipalSchema } from '@huabu/shared';

import { IdentityError } from './service.js';

import type { IdentityService, ResourceDirectory } from './service.js';
import type {
  BubbleAuthzOptions,
  BubbleStore,
  CreateBubbleRuntimeOptions,
} from '@octostaff/bubble';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Huabu's permission model, kept in Bubble's grant table and answered by
 * Bubble's policy. On Bubble's system target, a `member` may use Huabu and an
 * `owner` may also manage it; a system owner also holds every Huabu capability
 * on every Workspace and Space. A Workspace owner may read and write every
 * Space in that Workspace; a Space owner, that Space and the Spaces inside it.
 * Only a system owner grants the ownership roles, so there is no sharing
 * between members.
 */
const USE = 'huabu.use';
const MANAGE = 'huabu.manage';
const READ = 'huabu.space.read';
const WRITE = 'huabu.space.write';
const TARGET = { workspace: 'huabu.workspace', space: 'huabu.space' } as const;
const OWNER_ROLE = {
  workspace: 'huabu.workspace.owner',
  space: 'huabu.space.owner',
} as const;

function huabuAuthz(resources: ResourceDirectory): BubbleAuthzOptions {
  return {
    coreRoleCapabilities: { member: [USE], owner: [USE, MANAGE] },
    targets: {
      [TARGET.workspace]: {
        resolve: async (id) =>
          (await resources.workspaceExists(id)) ? { parent: null } : null,
      },
      [TARGET.space]: {
        resolve: async (id) => {
          const parent = await resources.spaceParent(id);
          return parent
            ? { parent: { type: TARGET[parent.type], id: parent.id } }
            : null;
        },
      },
    },
    roles: {
      [OWNER_ROLE.workspace]: {
        grantableOn: [TARGET.workspace],
        capabilities: [READ, WRITE],
        managementCapability: MANAGE,
      },
      [OWNER_ROLE.space]: {
        grantableOn: [TARGET.space],
        capabilities: [READ, WRITE],
        managementCapability: MANAGE,
      },
    },
    inheritance: [
      { from: TARGET.workspace, to: TARGET.space, capabilities: [READ, WRITE] },
      { from: TARGET.space, to: TARGET.space, capabilities: [READ, WRITE] },
    ],
  };
}

/** Bubble's records live beside Huabu's, in a schema of their own. */
export async function openBubblePostgresStore(
  url: string,
): Promise<BubbleStore> {
  const store = new PostgresBubbleStore(
    PostgresConnection.open({ url, schema: 'bubble' }),
  );
  try {
    await store.init();
  } catch (error) {
    await store.close();
    throw error;
  }
  return store;
}

/**
 * Run Bubble inside the Huabu server: one runtime backs both Huabu's admission
 * and Bubble's own API, so a credential resolves to the same principal through
 * either. The store is closed with the plugin.
 */
export async function openBubbleIdentity(options: {
  authenticator: NonNullable<CreateBubbleRuntimeOptions['authenticator']>;
  /** Principal provisioned as Bubble system owner. */
  owner?: string;
  store: BubbleStore;
  resources: ResourceDirectory;
}): Promise<{ service: IdentityService; plugin: FastifyPluginAsync }> {
  const { store, owner } = options;
  const runtime = await createBubbleRuntime({
    store,
    authenticator: options.authenticator,
    // Huabu owners are provisioned, never whoever logs in first.
    autoGrantFirstUserSystemOwner: false,
    authz: huabuAuthz(options.resources),
  }).catch(async (error: unknown) => {
    await store.close?.();
    throw error;
  });
  if (owner) {
    // Created without an external identity, which suits master-key callers; a
    // federated user is granted ownership through Bubble after first login.
    if (!(await store.principals.get(owner))) {
      await store.principals.upsert({ principalId: owner, kind: 'user' });
      await store.grants.add({
        target: { type: 'principal', principalId: owner },
        principalId: owner,
        role: 'owner',
        grantedByPrincipalId: null,
      });
    }
    await store.grants.add({
      target: { type: 'system' },
      principalId: owner,
      role: 'owner',
      grantedByPrincipalId: null,
    });
  }
  const { identity } = runtime.application;

  return {
    service: {
      provider: 'bubble',
      challenge: 'Bearer realm="Huabu"',
      async authenticate({ authorization, header }) {
        if (!authorization || !/^Bearer\s+\S+$/i.test(authorization))
          return null;
        try {
          // The verifier sees the headers Bubble's own routes would give it,
          // so the master-key principal override resolves identically.
          const auth = await authenticateBubbleRequest(runtime.authenticator, {
            authorization,
            method: 'GET',
            url: '/v1/auth/whoami',
            getHeader: (name) => header?.(name.toLowerCase()),
          });
          // Registration binds (issuer, subject) and refuses disabled accounts.
          const registered = await identity.register(auth, 'http');
          const whoami = await identity.whoAmIFor(
            { actorPrincipalId: registered.principalId },
            bubbleAuthContextToPrincipal(registered),
          );
          const { principalId } = registered;
          // One grant load and ancestry walk per request; a later request or
          // stream revalidation authenticates again and gets a fresh scope.
          const policy = runtime.policy.scoped();
          return {
            principal: identityPrincipalSchema.parse(whoami.principal),
            member: await policy.can(USE, principalId, { type: 'system' }),
            owner: await policy.can(MANAGE, principalId, { type: 'system' }),
            access: {
              can: (level, resource) =>
                policy.can(level === 'read' ? READ : WRITE, principalId, {
                  type: TARGET[resource.type],
                  id: resource.id,
                }),
              claim: async (resource) => {
                await store.grants.add({
                  target: { type: TARGET[resource.type], id: resource.id },
                  principalId,
                  role: OWNER_ROLE[resource.type],
                  grantedByPrincipalId: principalId,
                });
              },
            },
          };
        } catch (error) {
          if (isBubbleProtocolError(error)) {
            if (error.code === BubbleErrorCode.Unauthenticated) return null;
            if (error.code === BubbleErrorCode.Forbidden)
              throw new IdentityError(
                403,
                'IDENTITY_FORBIDDEN',
                'Identity access denied',
              );
          }
          // Store and verifier failures must never appear in a response.
          throw new IdentityError(
            503,
            'IDENTITY_UNAVAILABLE',
            'Identity service unavailable',
          );
        }
      },
    },
    plugin: async (app) => {
      // Bubble authenticates and authorizes each of its own routes, including
      // for principals that hold no Huabu permission.
      app.addHook('onRoute', (route) => {
        route.config = { ...route.config, identity: 'route-owned' };
      });

      // @fastify/websocket would otherwise route every upgrade on the server,
      // answering the Agentlet gateway's own upgrade path with a 404.
      const upgrades = new EventEmitter();
      const forward = (...args: unknown[]) => {
        const url = (args[0] as { url?: string }).url ?? '';
        if (url.startsWith(`${app.prefix}/`)) upgrades.emit('upgrade', ...args);
      };
      app.server.on('upgrade', forward);
      await app.register(websocket, {
        options: {
          server: upgrades as never,
          maxPayload: runtime.ctx.application.events.appendBodyLimit,
        },
      });
      await app.register(bubblePlugin(runtime, { healthCheck: false }));

      app.addHook('onReady', () => runtime.start());
      // Stop Bubble's workers before releasing the storage they query.
      app.addHook('onClose', async () => {
        app.server.off('upgrade', forward);
        await runtime.stop();
        await store.close?.();
      });
    },
  };
}
