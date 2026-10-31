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
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
      for (const url of ['/api/canvas', '/api/canvas/import']) {
        expect(
          (await call('dave', 'POST', url, { title: 'forbidden' })).status,
        ).toBe(403);
      }
      expect(
        (
          await call('dave', 'POST', `/api/canvas/${id}/children`, {
            title: 'forbidden',
          })
        ).status,
      ).toBe(403);
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

    it('lets editors save content but requires manage for renames and ownership-granting detachment', async () => {
      const { call, store, workspaceOf } = await host();
      const workspaceId = await workspaceOf('carol');
      const root = await call('carol', 'POST', '/api/canvas', {
        title: 'Root',
      });
      const id = root.body.canvasId as string;
      const child = await call('carol', 'POST', `/api/canvas/${id}/children`, {
        title: 'Child',
      });
      expect(child.status).toBe(200);
      const childId = child.body.canvasId as string;
      await store.grants.add({
        target: { type: 'huabu.workspace', id: workspaceId },
        principalId: 'dave',
        role: 'huabu.workspace.editor',
        grantedByPrincipalId: 'carol',
      });
      await call('dave', 'POST', `/api/workspaces/${workspaceId}/activate`);

      const before = (await call('dave', 'GET', `/api/canvas/${id}`)).body;
      const renamed = await call('dave', 'PUT', `/api/canvas/${id}`, {
        version: before.version,
        state: before.state,
        title: 'Stolen title',
      });
      expect(renamed.status).toBe(403);
      expect(
        (await call('carol', 'GET', `/api/canvas/${id}`)).body,
      ).toMatchObject({ title: 'Root', version: before.version });
      const saved = await call('dave', 'PUT', `/api/canvas/${id}`, {
        version: before.version,
        state: before.state,
        title: 'Root',
      });
      expect(saved.status).toBe(200);
      expect(
        (
          await call('dave', 'PATCH', `/api/canvas/${childId}/parent`, {
            parentSpaceId: null,
            expectedParentSpaceId: id,
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('carol', 'GET', '/api/canvas')).body.canvases.find(
          (space: { canvasId: string }) => space.canvasId === childId,
        ).parentSpaceId,
      ).toBe(id);
      expect(
        await store.grants.list({
          principalId: 'dave',
          target: { type: 'huabu.space', id: `${workspaceId}:${childId}` },
        }),
      ).toEqual([]);

      // Creating new Spaces, including children, still belongs to write access.
      expect(
        (await call('dave', 'POST', '/api/canvas', { title: 'Editor root' }))
          .status,
      ).toBe(201);
      const ownedRoot = (
        await call('dave', 'GET', '/api/canvas')
      ).body.canvases.find(
        (space: { title: string }) => space.title === 'Editor root',
      );
      // Reparenting beneath an owned Space must not turn inherited write
      // access on somebody else's child into inherited manage access.
      expect(
        (
          await call('dave', 'PATCH', `/api/canvas/${childId}/parent`, {
            parentSpaceId: ownedRoot.canvasId,
            expectedParentSpaceId: id,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('dave', 'POST', `/api/canvas/${id}/children`, {
            title: 'Editor child',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call('carol', 'PATCH', `/api/canvas/${childId}/parent`, {
            parentSpaceId: null,
            expectedParentSpaceId: id,
          })
        ).status,
      ).toBe(200);
      const current = (await call('carol', 'GET', `/api/canvas/${id}`)).body;
      expect(
        (
          await call('carol', 'PUT', `/api/canvas/${id}`, {
            version: current.version,
            state: current.state,
            title: 'Renamed',
          })
        ).status,
      ).toBe(200);
    });

    it('requires Workspace write to move into a new root, while a Space owner may create a child destination', async () => {
      const { call, store, workspaceOf, spacesOf } = await host();
      const workspaceId = await workspaceOf('carol');
      const source = await call('carol', 'POST', '/api/canvas', {
        title: 'Source',
      });
      const id = source.body.canvasId as string;
      await call('carol', 'POST', `/api/canvas/${id}/children`, {
        title: 'Selected child',
      });
      for (const [type, targetId, role] of [
        ['huabu.workspace', workspaceId, 'huabu.workspace.viewer'],
        ['huabu.space', `${workspaceId}:${id}`, 'huabu.space.owner'],
      ] as const)
        await store.grants.add({
          target: { type, id: targetId },
          principalId: 'dave',
          role,
          grantedByPrincipalId: 'carol',
        });
      await call('dave', 'POST', `/api/workspaces/${workspaceId}/activate`);
      const before = (await call('dave', 'GET', `/api/canvas/${id}`)).body;
      const move = {
        selectedNodeIds: [before.state.nodes[0].id],
        createSourcePreview: false,
        expectedSourceVersion: before.version,
      };
      for (const asChild of [false, undefined]) {
        expect(
          (
            await call('dave', 'POST', `/api/canvas/${id}/move-selection`, {
              ...move,
              destination: { kind: 'new', title: 'Forbidden', asChild },
            })
          ).status,
        ).toBe(403);
      }
      expect(await spacesOf('dave')).toEqual(['Selected child', 'Source']);
      expect((await call('dave', 'GET', `/api/canvas/${id}`)).body).toEqual(
        before,
      );
      const allowed = await call(
        'dave',
        'POST',
        `/api/canvas/${id}/move-selection`,
        {
          ...move,
          destination: { kind: 'new', title: 'Allowed child', asChild: true },
        },
      );
      expect(allowed.status).toBe(200);
      expect(
        (await call('dave', 'GET', '/api/canvas')).body.canvases.find(
          (item: { title: string }) => item.title === 'Allowed child',
        ).parentSpaceId,
      ).toBe(id);
    });

    it('requires management of every child reparented by a selection move before any mutations', async () => {
      const { call, store, workspaceOf } = await host();
      const workspaceId = await workspaceOf('carol');
      const source = await call('carol', 'POST', '/api/canvas', {
        title: 'Source',
      });
      const id = source.body.canvasId as string;
      const child = await call('carol', 'POST', `/api/canvas/${id}/children`, {
        title: 'Someone else owns this',
      });
      await store.grants.add({
        target: { type: 'huabu.workspace', id: workspaceId },
        principalId: 'dave',
        role: 'huabu.workspace.editor',
        grantedByPrincipalId: 'carol',
      });
      await call('dave', 'POST', `/api/workspaces/${workspaceId}/activate`);
      await call('dave', 'POST', `/api/canvas/${id}/children`, {
        title: 'Editors own the child they create',
      });
      const destination = await call('dave', 'POST', '/api/canvas', {
        title: 'Owned destination',
      });
      const destinationId = destination.body.canvasId as string;
      const before = (await call('dave', 'GET', `/api/canvas/${id}`)).body;
      const beforeDestination = (
        await call('dave', 'GET', `/api/canvas/${destinationId}`)
      ).body;
      const beforeSpaces = (await call('dave', 'GET', '/api/canvas')).body;
      const beforeGrants = await store.grants.list({ principalId: 'dave' });
      const move = {
        selectedNodeIds: before.state.nodes.map(
          (node: { id: string }) => node.id,
        ),
        createSourcePreview: false,
        expectedSourceVersion: before.version,
      };
      for (const target of [
        { kind: 'existing', canvasId: destinationId },
        { kind: 'new', title: 'Must not be created', asChild: true },
      ])
        expect(
          (
            await call('dave', 'POST', `/api/canvas/${id}/move-selection`, {
              ...move,
              destination: target,
            })
          ).status,
        ).toBe(403);
      expect((await call('dave', 'GET', `/api/canvas/${id}`)).body).toEqual(
        before,
      );
      expect(
        (await call('dave', 'GET', `/api/canvas/${destinationId}`)).body,
      ).toEqual(beforeDestination);
      expect((await call('dave', 'GET', '/api/canvas')).body).toEqual(
        beforeSpaces,
      );
      expect(await store.grants.list({ principalId: 'dave' })).toEqual(
        beforeGrants,
      );
      const allowed = await call(
        'carol',
        'POST',
        `/api/canvas/${id}/move-selection`,
        { ...move, destination: { kind: 'existing', canvasId: destinationId } },
      );
      expect(allowed.status).toBe(200);
      expect(
        (await call('carol', 'GET', '/api/canvas')).body.canvases.find(
          (item: { canvasId: string }) => item.canvasId === child.body.canvasId,
        ).parentSpaceId,
      ).toBe(destinationId);
    });
  });
}
