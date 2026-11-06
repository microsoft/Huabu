// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mountAgenetes as mountAgentRuntime } from '@agenetes/agenetes';
import {
  getAgentProfileRegistry,
  getAgentletGateway,
  mountAgenetes,
  resolveConnectedAgentletId,
} from '@agenetes/agentlet-host';
import { agentSpecSchema } from '@agenetes/protocol';
import { defineDriver } from '@agenetes/runtime';
import { PROTOCOL_VERSION } from '@agentlet/protocol';
import { InMemoryBubbleStore } from '@octostaff/bubble';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  agentletOwner,
  agentReachbackEnvironment,
  authenticateUserAgentlet,
  canUseAgentlet,
  ownDeviceCredential,
  readAgentCredential,
  resetAgentCredentials,
} from './agent-credentials.js';
import { openBubbleIdentity } from './bubble.js';
import { registerIdentity } from './http.js';
import {
  openPersonalSettings,
  useCaller,
  personalSettingsOwner,
} from './personal-settings.js';
import { createMemoryWorkspacePreferences } from './preferences.js';
import { getRequestIdentity } from './request.js';
import {
  _resetConnectionTokenForTests,
  getConnectionToken,
} from '../../connection-token.js';
import connectionRoutes from '../agent/acp/connection-token.route.js';
import deviceFilesRoutes from '../agent/acp/device-files.route.js';
import profilesRoutes from '../agent/acp/profiles.route.js';
import threadsRoutes from '../agent/acp/threads.route.js';
import { agenetes } from '../agent/agenetes/index.js';
import defaultsRoutes from '../agent/agent-defaults.route.js';
import { registerSpaceAccess } from '../security/space-access.js';
import { createSpace } from '../storage/index.js';
import { mountTestWorkspace } from '../storage/testing.js';
import { runInWorkspace } from '../workspace/context.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import { getWorkspaceHandle } from '../workspace.js';

import type { AgentReachback } from './agent-credentials.js';
import type { ResourceDirectory } from './service.js';
import type { WorkspaceScope } from '../workspace/context.js';
import type { FastifyInstance } from 'fastify';

let tmp: string;
let app: FastifyInstance;
/** The host's live-conversation check for reachback credentials. */
let liveReachback: (claims: AgentReachback) => Promise<boolean>;
beforeEach(() => {
  liveReachback = async () => true;
  tmp = mkdtempSync(join(tmpdir(), 'huabu-user-agents-'));
  vi.stubEnv('HUABU_DATA_DIR', tmp);
  vi.stubEnv('HUABU_IDENTITY_PROVIDER', 'bubble');
  vi.stubEnv('HUABU_CONNECTION_TOKEN', 'test-host-credential');
  _resetConnectionTokenForTests();
});
afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetConnectionTokenForTests();
  rmSync(tmp, { recursive: true, force: true });
});

const headers = (id: string) => ({
  authorization: 'Bearer master',
  'x-bubble-principal-id': id,
});
async function host(
  admin: boolean,
  scope: WorkspaceScope = {
    handle: { workspaceId: 'w1', name: 'Shared' },
    path: null,
  },
  revalidationIntervalMs?: number,
) {
  const store = new InMemoryBubbleStore();
  const resources: ResourceDirectory = {
    workspaceExists: async () => true,
    spaceParent: async () => ({
      type: 'workspace',
      id: scope.handle.workspaceId,
    }),
    workspaceOfSpace: async () => scope.handle.workspaceId,
    openWorkspace: async () => scope,
    defaultWorkspace: async () => scope,
    lockedWorkspace: async () => scope,
    createWorkspace: async () => {
      throw new Error('Already has a Workspace');
    },
  };
  const bubble = await openBubbleIdentity({
    authenticator: [
      {
        driver: 'master-key',
        masterKey: 'master',
        defaultPrincipalId: 'alice',
      },
    ],
    store,
    preferences: createMemoryWorkspacePreferences(),
    resources,
  });
  for (const id of ['alice', 'bob']) {
    await store.principals.upsert({ principalId: id, kind: 'user' });
    await store.grants.add({
      target: { type: 'system' },
      principalId: id,
      role: admin ? 'owner' : 'member',
      grantedByPrincipalId: null,
    });
    await store.grants.add({
      target: { type: 'huabu.workspace', id: scope.handle.workspaceId },
      principalId: id,
      role: 'huabu.workspace.owner',
      grantedByPrincipalId: null,
    });
  }
  app = Fastify();
  registerIdentity(app, {
    service: bubble.service,
    getConnectionToken,
    isCurrentReachback: (claims) => liveReachback(claims),
    revalidationIntervalMs,
  });
  app.register(bubble.plugin, { prefix: '/bubble' });
  registerSpaceAccess(app);
  mountAgenetes(app, {
    connectionToken: getConnectionToken(),
    dataDir: tmp,
    daemonEntryPath: '',
    supervise: false,
    canAccessAgentlet: canUseAgentlet,
    authenticate: authenticateUserAgentlet(bubble.service),
    profiles: {
      storageDir: join(tmp, 'profiles'),
      canAccess: (p) => canUseAgentlet(p.agentletId),
    },
  });
  app.register(profilesRoutes, { prefix: '/api/acp' });
  app.register(connectionRoutes, { prefix: '/api/acp' });
  app.register(deviceFilesRoutes, { prefix: '/api/acp' });
  app.register(defaultsRoutes, { prefix: '/api/agent/defaults' });
  app.register(threadsRoutes, { prefix: '/api/acp' });
  app.get('/api/rfs/w/:workspaceId/:canvasId/probe', async (request) => ({
    principalId: getRequestIdentity(request)?.principal.principalId,
    settingsOwner: personalSettingsOwner(),
  }));
  app.get(
    '/api/rfs/w/:workspaceId/:canvasId/stream',
    async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.write('data: ready\n\n');
    },
  );
  await app.ready();
  const as = async <T>(id: string, fn: () => T) =>
    openPersonalSettings(async () => {
      useCaller((await bubble.service.resolvePrincipal!(id))!);
      return fn();
    });
  return { store, service: bubble.service, as };
}

it.each([false, true])(
  'authorizes permission answers through the query Space and canonical private device (admin=%s)',
  async (admin) => {
    const opened = await mountTestWorkspace({
      structured: { kind: 'disk' },
      blobs: { kind: 'disk' },
    });
    const handle = getWorkspaceHandle();
    if (!handle) throw new Error('No test Workspace');
    const scope: WorkspaceScope = {
      handle,
      path: opened.workspacePath,
    };
    const answer = vi.fn().mockResolvedValue({ ok: true });
    const runtime = mountAgentRuntime({
      drivers: {
        external: defineDriver({
          schemaVersion: 1,
          workloadTypes: ['Deployment'],
          specSchema: agentSpecSchema.extend({ agentletId: z.string() }),
          stateSchema: z.object({}),
          initialState: () => ({}),
          create: () =>
            ({
              capabilities: {},
              async *run() {},
              control: answer,
              close() {},
            }) as never,
        }),
      },
    });
    vi.spyOn(agenetes, 'record').mockImplementation((...args) =>
      runtime.record(...args),
    );
    vi.spyOn(agenetes, 'get').mockImplementation((...args) =>
      runtime.get(...args),
    );
    const namespace = await runInWorkspace(scope, async () => {
      await createSpace('shared', 'Shared');
      await createSpace('other', 'Other');
      return canvasAcpNamespace('shared');
    });
    try {
      const h = await host(admin, scope);
      await authenticateUserAgentlet(h.service)(
        'alice-device',
        await h.as('alice', ownDeviceCredential),
      );
      await runtime.create({
        kind: 'external',
        workloadType: 'Deployment',
        namespace,
        threadId: 'alice-thread',
        spec: { agentletId: 'alice-device' },
      });
      const decide = (user: string, query = '', extra = {}) =>
        app.inject({
          method: 'POST',
          url: `/api/acp/threads/alice-thread/permission${query}`,
          headers: headers(user),
          payload: { requestId: 'pending', optionId: 'allow', ...extra },
        });
      expect((await decide('bob', '', { canvasId: 'shared' })).statusCode).toBe(
        400,
      );
      expect(answer).not.toHaveBeenCalled();
      expect((await decide('bob', '?canvasId=shared')).statusCode).toBe(403);
      expect(answer).not.toHaveBeenCalled();
      expect((await decide('alice', '?canvasId=other')).statusCode).toBe(404);
      expect(answer).not.toHaveBeenCalled();
      expect(
        (await decide('alice', '?canvasId=shared&canvasId=other')).statusCode,
      ).toBe(400);
      expect(answer).not.toHaveBeenCalled();
      expect((await decide('alice', '?canvasId=shared')).json()).toEqual({
        resolved: true,
      });
      expect(answer).toHaveBeenCalledExactlyOnceWith({
        type: 'answer_permission',
        data: { requestId: 'pending', decision: { optionId: 'allow' } },
      });
    } finally {
      await runtime.close('alice-thread', namespace);
      await app?.close();
      await opened.close();
    }
  },
);

it.each([false, true])(
  'keeps devices, profiles and defaults private for two users (admin=%s)',
  async (admin) => {
    const h = await host(admin);
    const alice = (
      await app.inject({
        method: 'POST',
        url: '/api/acp/connection-credentials',
        headers: headers('alice'),
        payload: {},
      })
    ).json();
    const bob = (
      await app.inject({
        method: 'POST',
        url: '/api/acp/connection-credentials',
        headers: headers('bob'),
        payload: {},
      })
    ).json();
    expect(alice.token).not.toBe(bob.token);
    expect(alice.token).not.toBe(getConnectionToken());
    const authenticate = authenticateUserAgentlet(h.service);
    await authenticate('alice-device', alice.token);
    await authenticate('bob-device', bob.token);
    const registry = getAgentProfileRegistry()!;
    const profile = await h.as('alice', () =>
      registry.createProfile({
        launchKind: 'acp-command',
        alias: 'Alice Codex',
        agentletId: 'alice-device',
        command: 'codex-acp',
        workingDirPath: '/alice',
      }),
    );
    const listing = await app.inject({
      url: '/api/acp/profiles',
      headers: headers('alice'),
    });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().profiles).toEqual([profile]);
    expect(
      (
        await app.inject({ url: '/api/acp/profiles', headers: headers('bob') })
      ).json().profiles,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/acp/profiles/${profile.id}`,
          headers: headers('bob'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/acp/files',
          headers: headers('bob'),
          payload: {
            agentletId: 'alice-device',
            operation: 'fs-list',
            args: { path: '/alice' },
          },
        })
      ).statusCode,
    ).toBe(403);
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/agent/defaults',
      headers: headers('alice'),
      payload: { profileId: profile.id, functionalModel: '' },
    });
    expect(changed.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/agent/defaults',
          headers: headers('alice'),
        })
      ).json().defaults.profileId,
    ).toBe(profile.id);
    expect(
      (
        await app.inject({
          url: '/api/agent/defaults',
          headers: headers('bob'),
        })
      ).json().defaults.profileId,
    ).toBe('huabu');
    expect(
      await h.as('bob', () => registry.getProfile(profile.id)),
    ).toBeUndefined();
    await expect(authenticate('alice-device', bob.token)).rejects.toThrow(
      'another user',
    );
    await expect(
      authenticate('other-device', getConnectionToken()),
    ).rejects.toThrow('User device credential');
  },
);

it('separates device transport from user and Space-scoped reachback, with fresh admission', async () => {
  const h = await host(true);
  const device = await h.as('alice', ownDeviceCredential);
  const authenticate = authenticateUserAgentlet(h.service);
  await authenticate('alice-device', device);
  expect(canUseAgentlet('alice-device')).toBe(true);
  expect(canUseAgentlet('alice-device', 'legacy-unowned-device')).toBe(false);
  await expect(
    agentReachbackEnvironment({ agentletId: 'legacy-unowned-device' }),
  ).rejects.toMatchObject({ code: 'DEVICE_ACCESS_REQUIRED' });
  const environment = await h.as('alice', () =>
    agentReachbackEnvironment({
      agentletId: 'alice-device',
      env: {
        HUABU_RFS_URL: 'https://huabu.example/api/rfs/w/w1/space-a',
        HUABU_THREAD_ID: 'thread-a',
      },
    }),
  );
  const token = environment!.HUABU_RFS_TOKEN;
  expect(readAgentCredential(token)).toMatchObject({
    aud: 'rfs',
    principalId: 'alice',
    threadId: 'thread-a',
  });
  const probe = (credential: string, path = '/api/rfs/w/w1/space-a/probe') =>
    app.inject({
      url: path,
      headers: { authorization: `Bearer ${credential}` },
    });
  expect((await probe(token)).json()).toEqual({
    principalId: 'alice',
    settingsOwner: 'alice',
  });
  // `$AGENTLET_TOKEN` on the device is its device credential. Reachback
  // written before HUABU_RFS_TOKEN still works with it, as the device owner
  // and only within their own Workspaces and Spaces, and only on RFS.
  expect((await probe(device)).json()).toEqual({
    principalId: 'alice',
    settingsOwner: 'alice',
  });
  expect((await probe(device, '/api/acp/profiles')).statusCode).toBe(401);
  expect((await probe(getConnectionToken())).statusCode).toBe(401);
  expect((await probe(token, '/api/rfs/w/w2/space-a/probe')).statusCode).toBe(
    401,
  );
  expect((await probe(token, '/api/rfs/w/w1/space-b/probe')).statusCode).toBe(
    401,
  );
  expect((await probe(token, '/api/acp/profiles')).statusCode).toBe(401);
  // A credential names its conversation: once that is gone, so is access.
  const asked: AgentReachback[] = [];
  liveReachback = async (claims) => {
    asked.push(claims);
    return false;
  };
  expect((await probe(token)).statusCode).toBe(401);
  expect(asked).toMatchObject([
    { principalId: 'alice', canvasId: 'space-a', threadId: 'thread-a' },
  ]);
  liveReachback = async () => true;
  await expect(authenticate('new-device', token)).rejects.toThrow(
    'User device credential',
  );
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[2], 'base64url').toString());
  parts[2] = Buffer.from(
    JSON.stringify({ ...payload, principalId: 'bob' }),
  ).toString('base64url');
  expect((await probe(parts.join('.'))).statusCode).toBe(401);
  await h.store.principals.update('alice', {
    disabledAt: new Date().toISOString(),
  });
  expect((await probe(token)).statusCode).toBe(401);
  expect((await probe(device)).statusCode).toBe(401);
  await expect(authenticate('alice-device', device)).rejects.toThrow(
    'not admitted',
  );
});

it("resets one person's device and reachback credentials without touching others", async () => {
  const h = await host(false);
  const authenticate = authenticateUserAgentlet(h.service);
  const alice = await h.as('alice', ownDeviceCredential);
  const bob = await h.as('bob', ownDeviceCredential);
  await authenticate('alice-device', alice);
  await authenticate('shared-box', alice);
  await authenticate('bob-device', bob);
  await expect(authenticate('shared-box', bob)).rejects.toThrow('another user');
  const reachback = (await h.as('alice', () =>
    agentReachbackEnvironment({
      agentletId: 'alice-device',
      env: {
        HUABU_RFS_URL: 'https://huabu.example/api/rfs/w/w1/space-a',
        HUABU_THREAD_ID: 'thread-a',
      },
    }),
  ))!.HUABU_RFS_TOKEN;
  const probe = (credential: string, path = '/api/rfs/w/w1/space-a/probe') =>
    app.inject({
      url: path,
      headers: { authorization: `Bearer ${credential}` },
    });
  expect((await probe(reachback)).statusCode).toBe(200);
  expect((await probe(alice)).statusCode).toBe(200);
  // A device credential reaches only Workspaces its owner holds a grant on.
  expect((await probe(alice, '/api/rfs/w/w2/space-a/probe')).statusCode).toBe(
    401,
  );

  resetAgentCredentials('alice');

  expect(readAgentCredential(alice)).toBeNull();
  expect((await probe(reachback)).statusCode).toBe(401);
  expect((await probe(alice)).statusCode).toBe(401);
  // Her devices stay hers, with their Profiles and conversations.
  expect(agentletOwner('alice-device')).toBe('alice');
  expect(agentletOwner('bob-device')).toBe('bob');
  await expect(authenticate('shared-box', bob)).rejects.toThrow('another user');
  // Her revoked command says so, instead of looking malformed.
  await expect(authenticate('alice-device', alice)).rejects.toThrow(
    'Device credentials were reset; copy a new connection command',
  );
  await expect(authenticate('bob-device', bob)).resolves.toBeDefined();
  // A new connection command reconnects the same device.
  const renewed = await h.as('alice', ownDeviceCredential);
  expect(renewed).not.toBe(alice);
  await expect(authenticate('alice-device', renewed)).resolves.toBeDefined();
});

it('closes open RFS streams once their credentials are reset', async () => {
  const h = await host(false, undefined, 20);
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const authenticate = authenticateUserAgentlet(h.service);
  const alice = await h.as('alice', ownDeviceCredential);
  const bob = await h.as('bob', ownDeviceCredential);
  await authenticate('alice-device', alice);
  await authenticate('bob-device', bob);
  const reachback = (
    await h.as('alice', () =>
      agentReachbackEnvironment({
        agentletId: 'alice-device',
        env: {
          HUABU_RFS_URL: 'https://huabu.example/api/rfs/w/w1/space-a',
          HUABU_THREAD_ID: 'thread-a',
        },
      }),
    )
  )?.HUABU_RFS_TOKEN;
  if (!reachback) throw new Error('No reachback credential');
  const open = async (credential: string) => {
    const response = await fetch(`${origin}/api/rfs/w/w1/space-a/stream`, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(3_000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing stream');
    expect((await reader.read()).done).toBe(false);
    return reader;
  };
  // Scoped reachback, and the device credential fallback.
  const scoped = await open(reachback);
  const device = await open(alice);
  const others = await open(bob);

  resetAgentCredentials('alice');

  expect((await scoped.read()).done).toBe(true);
  expect((await device.read()).done).toBe(true);
  // Bob's credentials were not reset; his stream outlives several checks.
  const outcome = await Promise.race([
    others.read().then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('open'), 150)),
  ]);
  expect(outcome).toBe('open');
  await others.cancel();
});

it.each([false, true])(
  'connects private devices through the real Gateway (admin=%s)',
  async (admin) => {
    const h = await host(admin);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const sockets: WebSocket[] = [];
    const connect = (id: string, token: string, hostname = id) =>
      new Promise<unknown>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/api/acp/agent?role=agentlet&id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
        );
        sockets.push(socket);
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'agentlet/hello',
              params: {
                agentletId: id,
                agentletProfile: {
                  bridge: { name: 'agentlet', version: PROTOCOL_VERSION },
                  machine: { hostname, platform: 'linux' },
                  capabilities: {
                    autoRestart: true,
                    bufferLimit: 1000,
                    maxAgents: 10,
                  },
                },
              },
            }),
          );
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id === 1) resolve(message);
        };
        socket.onerror = () => reject(new Error('Device connection failed'));
      });
    try {
      const alice = await h.as('alice', ownDeviceCredential);
      const bob = await h.as('bob', ownDeviceCredential);
      expect(await connect('alice-device', alice)).toHaveProperty('result');
      expect(await connect('bob-device', bob, 'alice-device')).toHaveProperty(
        'result',
      );
      const created = await app.inject({
        method: 'POST',
        url: '/api/acp/profiles',
        headers: headers('alice'),
        payload: {
          alias: 'Private Codex',
          agentletId: 'alice-device',
          workingDirPath: '/work',
          launch: { kind: 'acp-command', command: 'codex-acp' },
        },
      });
      expect(created.statusCode).toBe(200);
      const list = async (id: string) =>
        (
          await app.inject({ url: '/api/acp/profiles', headers: headers(id) })
        ).json();
      expect(
        (await list('alice')).connectedDevices.map(
          (d: { agentletId: string }) => d.agentletId,
        ),
      ).toEqual(['alice-device']);
      expect(
        (await list('bob')).connectedDevices.map(
          (d: { agentletId: string }) => d.agentletId,
        ),
      ).toEqual(['bob-device']);
      expect((await list('bob')).profiles).toEqual([]);
      sockets[0].close();
      await expect
        .poll(() => getAgentletGateway()?.getAgentlet('alice-device')?.status)
        .toBe('disconnected');
      expect(
        await h.as('alice', () => resolveConnectedAgentletId('alice-device')),
      ).toBeUndefined();
      expect(resolveConnectedAgentletId('alice-device')).toBeUndefined();
      expect(await connect('alice-device', bob)).toHaveProperty('error');
      expect(await connect('alice-device', alice)).toHaveProperty('result');
      // Resetting Alice's credentials drops her live device, not Bob's.
      resetAgentCredentials('alice');
      await expect
        .poll(() => getAgentletGateway()?.getAgentlet('alice-device')?.status)
        .toBe('disconnected');
      expect(getAgentletGateway()?.getAgentlet('bob-device')?.status).toBe(
        'connected',
      );
      expect(await connect('alice-device', alice)).toHaveProperty('error');
      // Her device, and the Profile on it, are not Bob's to claim.
      expect(await connect('alice-device', bob)).toHaveProperty('error');
      expect((await list('bob')).profiles).toEqual([]);
      expect((await list('alice')).profiles).toHaveLength(1);

      // A handshake admitted just before a reset does not connect after it.
      const renewed = await h.as('alice', ownDeviceCredential);
      let admit!: () => void;
      const admitted = new Promise<void>((resolve) => (admit = resolve));
      let looking!: () => void;
      const lookup = new Promise<void>((resolve) => (looking = resolve));
      const resolvePrincipal = h.service.resolvePrincipal?.bind(h.service);
      const gate = vi
        .spyOn(h.service, 'resolvePrincipal')
        .mockImplementationOnce(async (id) => {
          looking();
          await admitted;
          return (await resolvePrincipal?.(id)) ?? null;
        });
      const late = connect('late-device', renewed);
      await lookup;
      resetAgentCredentials('alice');
      admit();
      expect(await late).toHaveProperty('error');
      expect(getAgentletGateway()?.getAgentlet('late-device')).toBeUndefined();
      expect(agentletOwner('late-device')).toBeNull();
      gate.mockRestore();
    } finally {
      for (const socket of sockets) socket.close();
    }
  },
);
