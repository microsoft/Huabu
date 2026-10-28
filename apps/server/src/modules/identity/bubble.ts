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


import { getWorkspaceHandle } from '../workspace.js';
import { IdentityError } from './service.js';
import {
  chooseRequestWorkspace,
  selectRequestWorkspace,
} from './workspace-selection.js';

import type { WorkspacePreferences } from './preferences.js';
import type {
  HuabuResource,
  IdentityService,
  PeopleDirectory,
  ResourceDirectory,
} from './service.js';
import type { WorkspaceRole } from '@huabu/shared';
import type {
  BubbleAuthzOptions,
  BubbleStore,
  CreateBubbleRuntimeOptions,
} from '@octostaff/bubble';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Huabu's permission model, kept in Bubble's grant table and answered by
 * Bubble's policy (`docs/proposals/multi-user-service.md`, "Roles and
 * capabilities"). On the system target a `member` may use Huabu and an `owner`
 * may also administer the deployment; Bubble's system-owner rule gives the
 * latter every capability on every Workspace and Space too. On a Workspace or
 * a Space the same three capability names apply, and they flow down from a
 * Workspace to its root Spaces and from a Space to the Spaces inside it.
 */
const USE = 'huabu.use';
const ADMIN = 'huabu.admin';
const CAPABILITY = {
  read: 'huabu.read',
  write: 'huabu.write',
  manage: 'huabu.manage',
} as const;
const { read: READ, write: WRITE, manage: MANAGE } = CAPABILITY;
const TARGET = { workspace: 'huabu.workspace', space: 'huabu.space' } as const;
const SPACE_OWNER = 'huabu.space.owner';
const WORKSPACE_ROLE = {
  owner: 'huabu.workspace.owner',
  editor: 'huabu.workspace.editor',
  viewer: 'huabu.workspace.viewer',
} as const satisfies Record<WorkspaceRole, string>;

/** People administration over Bubble's principal and grant tables. */
function bubblePeople(store: BubbleStore): PeopleDirectory {
  const SYSTEM = { type: 'system' } as const;
  const roleOf = (role: string): WorkspaceRole | null =>
    (Object.keys(WORKSPACE_ROLE) as WorkspaceRole[]).find(
      (key) => WORKSPACE_ROLE[key] === role,
    ) ?? null;
  return {
    async list() {
      const [principals, grants] = await Promise.all([
        store.principals.list(),
        store.grants.list(),
      ]);
      return principals.map((principal) => {
        const held = grants.filter(
          (grant) => grant.principalId === principal.principalId,
        );
        const system = held.filter((grant) => grant.target.type === 'system');
        const workspaces = new Map<string, WorkspaceRole>();
        for (const grant of held) {
          const role = roleOf(grant.role);
          if (
            grant.target.type === TARGET.workspace &&
            'id' in grant.target &&
            role
          )
            workspaces.set(grant.target.id, role);
        }
        return {
          principal: identityPrincipalSchema.parse({
            principalId: principal.principalId,
            kind: principal.kind,
            ...(principal.displayName
              ? { displayName: principal.displayName }
              : {}),
            ...(principal.email ? { email: principal.email } : {}),
            ...(principal.avatarUrl ? { avatarUrl: principal.avatarUrl } : {}),
          }),
          member: system.some((grant) => grant.role === 'member'),
          admin: system.some((grant) => grant.role === 'owner'),
          workspaces: [...workspaces].map(([workspaceId, role]) => ({
            workspaceId,
            role,
          })),
        };
      });
    },
    async setMember(principalId, member, by) {
      if (!(await store.principals.get(principalId))) return false;
      const rows = await store.grants.list({ target: SYSTEM, principalId });
      const current = rows.filter((row) => row.role === 'member');
      if (member && current.length === 0)
        await store.grants.add({
          target: SYSTEM,
          principalId,
          role: 'member',
          grantedByPrincipalId: by,
        });
      if (!member)
        for (const row of current) await store.grants.remove(row.grantId);
      return true;
    },
    async setWorkspaceRole(principalId, workspaceId, role, by) {
      if (!(await store.principals.get(principalId))) return false;
      const target = { type: TARGET.workspace, id: workspaceId };
      const rows = await store.grants.list({ target, principalId });
      for (const row of rows)
        if (roleOf(row.role) && row.role !== (role && WORKSPACE_ROLE[role]))
          await store.grants.remove(row.grantId);
      if (role && !rows.some((row) => row.role === WORKSPACE_ROLE[role]))
        await store.grants.add({
          target,
          principalId,
          role: WORKSPACE_ROLE[role],
          grantedByPrincipalId: by,
        });
      return true;
    },
  };
}

/**
 * A Space's Bubble target names its Workspace too, so a Space can later be
 * shared on its own and two Workspaces can never share a grant by id.
 */
export function spaceTargetId(workspaceId: string, canvasId: string): string {
  return `${workspaceId}:${canvasId}`;
}

function parseSpaceTargetId(
  id: string,
): { workspaceId: string; canvasId: string } | null {
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) return null;
  return { workspaceId: id.slice(0, at), canvasId: id.slice(at + 1) };
}

function huabuAuthz(resources: ResourceDirectory): BubbleAuthzOptions {
  const flowing = [READ, WRITE, MANAGE];
  return {
    coreRoleCapabilities: { member: [USE], owner: [USE, ADMIN] },
    targets: {
      [TARGET.workspace]: {
        resolve: async (id) =>
          (await resources.workspaceExists(id)) ? { parent: null } : null,
      },
      [TARGET.space]: {
        resolve: async (id) => {
          const target = parseSpaceTargetId(id);
          if (!target) return null;
          const parent = await resources.spaceParent(
            target.workspaceId,
            target.canvasId,
          );
          if (!parent) return null;
          return {
            parent:
              parent.type === 'space'
                ? {
                    type: TARGET.space,
                    id: spaceTargetId(target.workspaceId, parent.id),
                  }
                : { type: TARGET.workspace, id: parent.id },
          };
        },
      },
    },
    // Granting a role on a Workspace or Space takes `huabu.manage` there, so
    // an owner can share what they own; nothing here grants system roles.
    roles: {
      [WORKSPACE_ROLE.owner]: {
        grantableOn: [TARGET.workspace],
        capabilities: [READ, WRITE, MANAGE],
        managementCapability: MANAGE,
      },
      [WORKSPACE_ROLE.editor]: {
        grantableOn: [TARGET.workspace],
        capabilities: [READ, WRITE],
        managementCapability: MANAGE,
      },
      [WORKSPACE_ROLE.viewer]: {
        grantableOn: [TARGET.workspace],
        capabilities: [READ],
        managementCapability: MANAGE,
      },
      [SPACE_OWNER]: {
        grantableOn: [TARGET.space],
        capabilities: [READ, WRITE, MANAGE],
        managementCapability: MANAGE,
      },
    },
    inheritance: [
      { from: TARGET.workspace, to: TARGET.space, capabilities: flowing },
      { from: TARGET.space, to: TARGET.space, capabilities: flowing },
    ],
  };
}

/**
 * Rewrite #237's Space grants, which named a Space by id alone, to name the
 * Workspace holding it. A grant on a Space no Workspace holds is dropped.
 * Idempotent: qualified grants are left alone.
 */
export async function migrateSpaceGrants(
  store: BubbleStore,
  resources: ResourceDirectory,
): Promise<void> {
  for (const grant of await store.grants.list()) {
    const { target } = grant;
    if (target.type !== TARGET.space || !('id' in target)) continue;
    if (parseSpaceTargetId(target.id)) continue;
    const workspaceId = await resources.workspaceOfSpace(target.id);
    if (workspaceId)
      await store.grants.add({
        target: {
          type: TARGET.space,
          id: spaceTargetId(workspaceId, target.id),
        },
        principalId: grant.principalId,
        role: grant.role,
        grantedByPrincipalId: grant.grantedByPrincipalId ?? null,
      });
    await store.grants.remove(grant.grantId);
  }
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
  preferences: WorkspacePreferences;
  resources: ResourceDirectory;
}): Promise<{ service: IdentityService; plugin: FastifyPluginAsync }> {
  const { store, owner, preferences } = options;
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
  await migrateSpaceGrants(store, options.resources).catch(
    async (error: unknown) => {
      await store.close?.();
      throw error;
    },
  );
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
      people: bubblePeople(store),
      selectWorkspace: (identity) =>
        selectRequestWorkspace(identity, preferences, options.resources),
      chooseWorkspace: (identity, workspaceId) =>
        chooseRequestWorkspace(
          identity,
          preferences,
          options.resources,
          workspaceId,
        ),
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
          const admin = await policy.can(ADMIN, principalId, {
            type: 'system',
          });
          // A Space is the one of that id in the Workspace this call runs in.
          const target = (resource: HuabuResource) => {
            if (resource.type === 'workspace')
              return { type: TARGET.workspace, id: resource.id };
            const workspaceId = getWorkspaceHandle()?.workspaceId;
            return workspaceId
              ? {
                  type: TARGET.space,
                  id: spaceTargetId(workspaceId, resource.id),
                }
              : null;
          };
          return {
            principal: identityPrincipalSchema.parse(whoami.principal),
            member: await policy.can(USE, principalId, { type: 'system' }),
            owner: admin,
            access: {
              can: async (level, resource) => {
                const resolved = target(resource);
                return resolved
                  ? policy.can(CAPABILITY[level], principalId, resolved)
                  : false;
              },
              claim: async (resource) => {
                const resolved = target(resource);
                if (!resolved)
                  throw new Error('A Space is claimed inside a Workspace');
                await store.grants.add({
                  target: resolved,
                  principalId,
                  role:
                    resource.type === 'space'
                      ? SPACE_OWNER
                      : WORKSPACE_ROLE.owner,
                  grantedByPrincipalId: principalId,
                });
              },
              // A Space shared on its own makes its Workspace enterable; what
              // the caller sees there is still decided Space by Space.
              workspaces: async () => {
                if (admin) return 'all';
                const ids = new Set<string>();
                for (const grant of await store.grants.list({ principalId })) {
                  const granted = grant.target;
                  if (!('id' in granted)) continue;
                  if (granted.type === TARGET.workspace) ids.add(granted.id);
                  if (granted.type === TARGET.space) {
                    const space = parseSpaceTargetId(granted.id);
                    if (space) ids.add(space.workspaceId);
                  }
                }
                return [...ids];
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
        await preferences.close();
      });
    },
  };
}
