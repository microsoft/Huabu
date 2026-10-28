// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { join } from 'node:path';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { openBubbleIdentity } from './bubble.js';
import { registerIdentity } from './http.js';
import { createMemoryWorkspacePreferences } from './preferences.js';
import { storageResourceDirectory } from './resources.js';
import canvasRoutes from '../canvas/canvas.route.js';
import { registerSpaceAccess } from '../security/space-access.js';
import workspaceRoutes from '../workspace.route.js';
import workspacesRoutes from '../workspaces.route.js';

import type { FastifyInstance } from 'fastify';

/**
 * Several people on one Server, end to end: Bubble admission, the Space guard
 * and the real routes, over real Disk storage. Each person works in their own
 * Workspace at the same time, and one person's switch moves nobody else.
 */

const MASTER = 'Bearer master-secret';
const as = (principalId: string) => ({
  authorization: MASTER,
  'x-bubble-principal-id': principalId,
});

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

async function host() {
  const store = new InMemoryBubbleStore();
  const bubble = await openBubbleIdentity({
    authenticator: [
      {
        driver: 'master-key',
        masterKey: 'master-secret',
        defaultPrincipalId: 'admin',
      },
    ],
    owner: 'admin',
    store,
    preferences: createMemoryWorkspacePreferences(),
    resources: storageResourceDirectory,
  });
  for (const principalId of ['carol', 'dave']) {
    await store.principals.upsert({ principalId, kind: 'user' });
    await store.grants.add({
      target: { type: 'system' },
      principalId,
      role: 'member',
      grantedByPrincipalId: null,
    });
  }
  const app = Fastify();
  servers.push(app);
  registerIdentity(app, {
    service: bubble.service,
    getConnectionToken: () => 'machine-secret',
  });
  registerSpaceAccess(app);
  await app.register(canvasRoutes, { prefix: '/api/canvas' });
  await app.register(workspaceRoutes, { prefix: '/api/workspace' });
  await app.register(workspacesRoutes, { prefix: '/api/workspaces' });

  const call = async (
    principalId: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: as(principalId),
      payload,
    });
    return {
      status: response.statusCode,
      body: response.body ? response.json() : undefined,
    };
  };
  const workspaceOf = async (principalId: string) =>
    (await call(principalId, 'GET', '/api/workspace')).body.workspaceId;
  const spacesOf = async (principalId: string) =>
    (
      (await call(principalId, 'GET', '/api/canvas')).body.canvases as Array<{
        title: string;
      }>
    )
      .map((space) => space.title)
      .sort();
  return { app, store, call, workspaceOf, spacesOf };
}

/**
 * The scenarios, for one storage backend. `tmp` is a scratch directory the
 * backend's setup owns; a folder path a member must not be able to adopt.
 */
export function describeSeveralPeople(
  backend: string,
  scratch: () => string,
): void {
  describe(`several people on one Server (${backend})`, () => {
    it('gives each member a Workspace of their own and keeps their Spaces apart', async () => {
      const { call, workspaceOf, spacesOf } = await host();
      const [carolWs, daveWs, adminWs] = await Promise.all([
        workspaceOf('carol'),
        workspaceOf('dave'),
        workspaceOf('admin'),
      ]);
      expect(new Set([carolWs, daveWs, adminWs]).size).toBe(3);

      // Interleaved creates land in each caller's own Workspace.
      const created = await Promise.all(
        ['carol', 'dave', 'carol', 'dave'].map((principalId, index) =>
          call(principalId, 'POST', '/api/canvas', {
            title: `${principalId} ${index}`,
          }),
        ),
      );
      expect(created.map((response) => response.status)).toEqual([
        201, 201, 201, 201,
      ]);
      expect(await spacesOf('carol')).toEqual(['carol 0', 'carol 2']);
      expect(await spacesOf('dave')).toEqual(['dave 1', 'dave 3']);
      expect(await spacesOf('admin')).toEqual([]);

      // Another person's Space is missing, not forbidden.
      const carols = created[0].body.canvasId as string;
      expect((await call('dave', 'GET', `/api/canvas/${carols}`)).status).toBe(
        404,
      );
      expect((await call('carol', 'GET', `/api/canvas/${carols}`)).status).toBe(
        200,
      );

      // Members never learn where the Server keeps their folder.
      const info = (await call('carol', 'GET', '/api/workspace')).body;
      expect(info).toMatchObject({
        path: null,
        capabilities: {
          canChangeWorkspace: true,
          nativePicker: false,
          namedWorkspaces: true,
        },
      });
    });

    it('switches only its caller, among Workspaces they may enter', async () => {
      const { call, workspaceOf, spacesOf } = await host();
      const daveWs = await workspaceOf('dave');
      const carolWs = await workspaceOf('carol');
      await call('carol', 'POST', '/api/canvas', { title: 'first' });

      const made = await call('carol', 'POST', '/api/workspaces', {
        name: 'Side project',
      });
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ name: 'Side project', path: null });
      const listed = (await call('carol', 'GET', '/api/workspaces'))
        .body as Array<{
        workspaceId: string;
        active: boolean;
      }>;
      expect(listed.map((w) => w.workspaceId).sort()).toEqual(
        [carolWs, made.body.workspaceId].sort(),
      );

      const switched = await call(
        'carol',
        'POST',
        `/api/workspaces/${made.body.workspaceId}/activate`,
      );
      expect(switched.body).toMatchObject({ active: true });
      expect(await workspaceOf('carol')).toBe(made.body.workspaceId);
      expect(await spacesOf('carol')).toEqual([]);
      expect(await workspaceOf('dave')).toBe(daveWs);

      // Someone else's Workspace is not there to switch to, rename or remove.
      for (const [method, url] of [
        ['POST', `/api/workspaces/${daveWs}/activate`],
        ['PATCH', `/api/workspaces/${daveWs}`],
        ['DELETE', `/api/workspaces/${daveWs}`],
      ] as const) {
        const response = await call('carol', method, url, { name: 'mine now' });
        expect(response.status).toBe(404);
      }
      expect(await workspaceOf('dave')).toBe(daveWs);

      // Folder operations stay with the administrator.
      expect(
        (
          await call('carol', 'POST', '/api/workspaces', {
            path: join(scratch(), 'elsewhere'),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call('carol', 'POST', '/api/workspace/validate-path', {
            path: '/',
          })
        ).status,
      ).toBe(403);

      // Back to the first Workspace; its Space is still there.
      await call('carol', 'POST', `/api/workspaces/${carolWs}/activate`);
      expect(await spacesOf('carol')).toEqual(['first']);
    });

    it('lets a viewer read a shared Workspace but not change it', async () => {
      const { call, store, workspaceOf } = await host();
      const carolWs = await workspaceOf('carol');
      const space = await call('carol', 'POST', '/api/canvas', {
        title: 'notes',
      });
      await store.grants.add({
        target: { type: 'huabu.workspace', id: carolWs },
        principalId: 'dave',
        role: 'huabu.workspace.viewer',
        grantedByPrincipalId: 'carol',
      });
      await workspaceOf('dave');
      await call('dave', 'POST', `/api/workspaces/${carolWs}/activate`);
      const id = space.body.canvasId as string;
      expect((await call('dave', 'GET', `/api/canvas/${id}`)).status).toBe(200);
      expect((await call('dave', 'DELETE', `/api/canvas/${id}`)).status).toBe(
        403,
      );
      expect(
        (
          await call('dave', 'PATCH', `/api/workspaces/${carolWs}`, {
            name: 'x',
          })
        ).status,
      ).toBe(404);
    });
  });
}
