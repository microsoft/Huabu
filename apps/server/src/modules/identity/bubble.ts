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

import type { IdentityService } from './service.js';
import type {
  BubbleStore,
  CreateBubbleRuntimeOptions,
} from '@octostaff/bubble';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Huabu's permissions, added to Bubble's roles and granted on Bubble's system
 * target: a system `member` may use Huabu, a system `owner` may also manage it.
 */
const USE = 'huabu.use';
const MANAGE = 'huabu.manage';
const HUABU_ROLES = {
  capabilitiesByRole: { member: [USE], owner: [USE, MANAGE] },
} as const;

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
}): Promise<{ service: IdentityService; plugin: FastifyPluginAsync }> {
  const { store, owner } = options;
  const runtime = await createBubbleRuntime({
    store,
    authenticator: options.authenticator,
    // Huabu owners are provisioned, never whoever logs in first.
    autoGrantFirstUserSystemOwner: false,
    authzContributions: [HUABU_ROLES],
  }).catch(async (error: unknown) => {
    await store.close?.();
    throw error;
  });
  if (owner) {
    // Created without an external identity, which suits master-key callers; a
    // federated user is granted ownership through Bubble after first login.
    if (!(await store.principals.get(owner))) {
      await store.principals.upsert({ principalId: owner, kind: 'user' });
      await store.grants.grant(
        { type: 'principal', principalId: owner },
        owner,
        'owner',
      );
    }
    await store.grants.grant({ type: 'system' }, owner, 'owner');
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
          const authz = runtime.policy.forCaller(registered.principalId);
          return {
            principal: identityPrincipalSchema.parse(whoami.principal),
            member: await authz.can(USE, { type: 'system' }),
            owner: await authz.can(MANAGE, { type: 'system' }),
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
