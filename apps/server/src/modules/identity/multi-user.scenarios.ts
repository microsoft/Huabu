// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { openBubbleIdentity } from './bubble.js';
import { registerIdentity } from './http.js';
import peopleRoutes from './people.route.js';
import { createMemoryWorkspacePreferences } from './preferences.js';
import { storageResourceDirectory } from './resources.js';
import canvasRoutes from '../canvas/canvas.route.js';
import { registerSpaceAccess } from '../security/space-access.js';
import { getWorkspaceRepository } from '../storage/index.js';
import { workspaceScopedRoutes } from '../workspace/scoped-routes.js';
import workspaceRoutes from '../workspace.route.js';
import workspacesRoutes from '../workspaces.route.js';

import type { BubbleStore } from '@octostaff/bubble';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

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

export async function host(options: { revalidationIntervalMs?: number } = {}) {
  const store: BubbleStore = new InMemoryBubbleStore();
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
    revalidationIntervalMs: options.revalidationIntervalMs,
  });
  registerSpaceAccess(app);
  await app.register(canvasRoutes, { prefix: '/api/canvas' });
  await app.register(workspaceRoutes, { prefix: '/api/workspace' });
  await app.register(peopleRoutes, {
    prefix: '/api/people',
    service: bubble.service,
  });
  await app.register(workspacesRoutes, { prefix: '/api/workspaces' });
  // A long-lived Space stream that names its Workspace, as agent reachback does.
  const streams: FastifyPluginAsync = async (scoped) => {
    scoped.get('/:canvasId/events', async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.write('data: ready\n\n');
    });
  };
  await app.register(workspaceScopedRoutes(streams), {
    prefix: '/api/rfs/w/:workspaceId',
  });

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
 * backend's setup owns; on Disk any user may adopt a folder in it.
 */
export function describeSeveralPeople(
  backend: string,
  scratch: () => string,
): void {
  // Only Disk keeps Workspaces as folders a person can open by path.
  const folders = backend === 'Disk';
  describe(`several people on one Server (${backend})`, () => {
    it('allows concurrent first-request writes after personal Workspace provisioning', async () => {
      const { call, spacesOf } = await host();
      const created = await Promise.all(
        ['First', 'Second'].map((title) =>
          call('carol', 'POST', '/api/canvas', { title }),
        ),
      );
      expect(created.map((response) => response.status)).toEqual([201, 201]);
      expect(await spacesOf('carol')).toEqual(['First', 'Second']);
    });

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

      // Where Workspaces are folders, everyone sees and may open them.
      const info = (await call('carol', 'GET', '/api/workspace')).body;
      expect(info).toMatchObject({
        capabilities: {
          canChangeWorkspace: true,
          nativePicker: false,
          namedWorkspaces: true,
          folderWorkspaces: folders,
        },
      });
      expect(typeof info.path).toBe(folders ? 'string' : 'object');
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
      expect(made.body.name).toBe('Side project');
      expect(made.body.path === null).toBe(!folders);
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

      // On Disk a folder becomes its opener's Workspace; elsewhere there are
      // no Server folders to open.
      const opened = await call('carol', 'POST', '/api/workspaces', {
        path: join(scratch(), 'elsewhere'),
        name: 'Elsewhere',
      });
      if (folders) {
        expect(opened.status).toBe(201);
        expect(opened.body).toMatchObject({
          name: 'Elsewhere',
          path: join(scratch(), 'elsewhere'),
        });
        expect(
          (
            await call(
              'carol',
              'POST',
              `/api/workspaces/${opened.body.workspaceId}/activate`,
            )
          ).status,
        ).toBe(200);
        expect(await workspaceOf('carol')).toBe(opened.body.workspaceId);
        expect(
          (
            await call(
              'dave',
              'POST',
              `/api/workspaces/${opened.body.workspaceId}/activate`,
            )
          ).status,
        ).toBe(404);
      } else {
        expect(opened.status).toBe(409);
        expect(opened.body.code).toBe('STORAGE_CAPABILITY_UNAVAILABLE');
      }
      // Probing arbitrary Server paths and moving the process-wide Workspace
      // stay with local and administrator callers.
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

    it.runIf(folders)(
      'keeps a folder Workspace with the person who opened it',
      async () => {
        const { call, store, workspaceOf } = await host();
        await workspaceOf('dave');
        const folder = join(scratch(), 'carols-folder');
        const opened = await call('carol', 'POST', '/api/workspaces', {
          path: folder,
          name: 'Carol folder',
        });
        expect(opened.status).toBe(201);
        const id = opened.body.workspaceId as string;
        // Another spelling of the same folder is the same Workspace.
        const alias = join(scratch(), 'carols-alias');
        symlinkSync(folder, alias, 'dir');
        const renameAttempt = { name: 'Mine now' };

        // Without a grant the folder is somebody's Workspace, not theirs.
        for (const path of [folder, alias]) {
          for (const body of [{ path }, { path, ...renameAttempt }])
            expect(
              (await call('dave', 'POST', '/api/workspaces', body)).status,
            ).toBe(404);
        }

        // A viewer may open it by path, but neither renames nor owns it.
        await store.grants.add({
          target: { type: 'huabu.workspace', id },
          principalId: 'dave',
          role: 'huabu.workspace.viewer',
          grantedByPrincipalId: 'carol',
        });
        for (const path of [folder, alias]) {
          const reopened = await call('dave', 'POST', '/api/workspaces', {
            path,
          });
          expect(reopened.status).toBe(200);
          expect(reopened.body.workspaceId).toBe(id);
          expect(
            (
              await call('dave', 'POST', '/api/workspaces', {
                path,
                ...renameAttempt,
              })
            ).status,
          ).toBe(404);
        }
        expect(
          (await call('dave', 'PATCH', `/api/workspaces/${id}`, renameAttempt))
            .status,
        ).toBe(404);
        const roles = (
          await store.grants.list({
            target: { type: 'huabu.workspace', id },
            principalId: 'dave',
          })
        ).map((grant) => grant.role);
        expect(roles).toEqual(['huabu.workspace.viewer']);

        // Its owner still names it by path.
        const renamed = await call('carol', 'POST', '/api/workspaces', {
          path: folder,
          name: 'Renamed',
        });
        expect(renamed).toMatchObject({
          status: 200,
          body: { workspaceId: id, name: 'Renamed' },
        });
      },
    );

    it('advertises top-level Space creation only where the caller may write the Workspace', async () => {
      const { call, store, workspaceOf } = await host();
      const canCreate = async (principalId: string) =>
        (await call(principalId, 'GET', '/api/workspace')).body.capabilities
          .canCreateSpaces;
      const carolWs = await workspaceOf('carol');
      const daveWs = await workspaceOf('dave');
      expect(await canCreate('carol')).toBe(true);
      expect(await canCreate('admin')).toBe(true);

      // Given one of carol's Spaces, dave may enter her Workspace but not
      // add to its top level.
      const shared = await call('carol', 'POST', '/api/canvas', {
        title: 'shared',
      });
      await store.grants.add({
        target: {
          type: 'huabu.space',
          id: `${carolWs}:${shared.body.canvasId as string}`,
        },
        principalId: 'dave',
        role: 'huabu.space.owner',
        grantedByPrincipalId: 'carol',
      });
      await call('dave', 'POST', `/api/workspaces/${carolWs}/activate`);
      expect(await workspaceOf('dave')).toBe(carolWs);
      expect(await canCreate('dave')).toBe(false);
      expect(
        (await call('dave', 'POST', '/api/canvas', { title: 'x' })).status,
      ).toBe(403);

      // A viewer of the whole Workspace may not either; an editor may.
      for (const [role, expected] of [
        ['huabu.workspace.viewer', false],
        ['huabu.workspace.editor', true],
      ] as const) {
        const grant = await store.grants.add({
          target: { type: 'huabu.workspace', id: carolWs },
          principalId: 'dave',
          role,
          grantedByPrincipalId: 'carol',
        });
        expect(await canCreate('dave')).toBe(expected);
        await store.grants.remove(grant.grant.grantId);
      }

      // Back home, dave creates as before.
      await call('dave', 'POST', `/api/workspaces/${daveWs}/activate`);
      expect(await canCreate('dave')).toBe(true);
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

      // Nor may a child the owner just made be detached into a new root.
      const child = await call('dave', 'POST', `/api/canvas/${id}/children`, {
        title: 'Detach me',
      });
      expect(child.status).toBe(200);
      const childId = child.body.canvasId as string;
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
          (item: { canvasId: string }) => item.canvasId === childId,
        ).parentSpaceId,
      ).toBe(id);
    });

    it("keeps an administrator's stream open in the Workspace its URL names, not their current one", async () => {
      const { app, call, workspaceOf } = await host({
        revalidationIntervalMs: 20,
      });
      const home = await workspaceOf('admin');
      const side = (
        await call('admin', 'POST', '/api/workspaces', { name: 'Side' })
      ).body.workspaceId as string;
      await call('admin', 'POST', `/api/workspaces/${side}/activate`);
      const space = (
        await call('admin', 'POST', '/api/canvas', { title: 'There' })
      ).body.canvasId as string;
      await call('admin', 'POST', `/api/workspaces/${home}/activate`);
      expect(await workspaceOf('admin')).toBe(home);

      const origin = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(
        `${origin}/api/rfs/w/${side}/${space}/events`,
        { headers: as('admin'), signal: AbortSignal.timeout(3_000) },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      // Several revalidations later, the stream is still open.
      const next = reader.read();
      const outcome = await Promise.race([
        next.then(() => 'ended'),
        new Promise((resolve) => setTimeout(resolve, 200, 'open')),
      ]);
      expect(outcome).toBe('open');
      await reader.cancel();
    });

    it('leaves no ownerless Workspace behind when making a personal one fails', async () => {
      const { call, store, workspaceOf } = await host();
      const before = (await getWorkspaceRepository().list()).map(
        (w) => w.workspaceId,
      );
      const add = store.grants.add.bind(store.grants);
      let failures = 1;
      store.grants.add = async (input) => {
        if (input.target.type === 'huabu.workspace' && failures-- > 0)
          throw new Error('Bubble store unavailable');
        return add(input);
      };
      expect(
        (await call('carol', 'GET', '/api/workspace')).status,
      ).toBeGreaterThanOrEqual(500);
      expect(
        (await getWorkspaceRepository().list()).map((w) => w.workspaceId),
      ).toEqual(before);

      const carolWs = await workspaceOf('carol');
      expect(
        (await getWorkspaceRepository().list())
          .map((w) => w.workspaceId)
          .sort(),
      ).toEqual([...before, carolWs].sort());

      // The same holds for a Workspace made by name.
      failures = 1;
      expect(
        (await call('carol', 'POST', '/api/workspaces', { name: 'Doomed' }))
          .status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await getWorkspaceRepository().list()).map((w) => w.name),
      ).not.toContain('Doomed');
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

    it('lets an administrator admit, revoke and give Workspace roles', async () => {
      const { call, store, workspaceOf, spacesOf } = await host();
      await store.principals.upsert({ principalId: 'erin', kind: 'user' });
      // Signed in, not admitted.
      expect((await call('erin', 'GET', '/api/canvas')).status).toBe(403);
      expect((await call('carol', 'GET', '/api/people')).status).toBe(403);

      const listed = (await call('admin', 'GET', '/api/people')).body as Array<{
        principal: { principalId: string };
        member: boolean;
        admin: boolean;
      }>;
      expect(
        Object.fromEntries(
          listed.map((p) => [p.principal.principalId, [p.member, p.admin]]),
        ),
      ).toMatchObject({
        admin: [false, true],
        carol: [true, false],
        erin: [false, false],
      });

      const admit = (principalId: string, member: boolean) =>
        call('admin', 'PUT', `/api/people/${principalId}/member`, { member });
      expect((await admit('erin', true)).status).toBe(204);
      expect((await call('erin', 'GET', '/api/canvas')).status).toBe(200);
      expect((await admit('nobody', true)).status).toBe(404);
      expect((await admit('admin', false)).status).toBe(409);

      // A Workspace role lets Erin enter Carol's Workspace and edit there,
      // beside the personal Workspace her first admitted request made.
      const carolWs = await workspaceOf('carol');
      await call('carol', 'POST', '/api/canvas', { title: 'plan' });
      // #356 retains system-owner access. People role choices use the
      // existing Workspace list, including each member's Workspace.
      expect(
        (await call('admin', 'GET', '/api/workspaces')).body.map(
          (w: { workspaceId: string }) => w.workspaceId,
        ),
      ).toContain(carolWs);
      const adminWs = await workspaceOf('admin');
      expect(
        (await call('admin', 'POST', `/api/workspaces/${carolWs}/activate`))
          .status,
      ).toBe(200);
      expect(await spacesOf('admin')).toEqual(['plan']);
      await call('admin', 'POST', `/api/workspaces/${adminWs}/activate`);
      expect(
        (
          await call('admin', 'PUT', `/api/people/erin/workspaces/${carolWs}`, {
            role: 'editor',
          })
        ).status,
      ).toBe(204);
      await call('erin', 'POST', `/api/workspaces/${carolWs}/activate`);
      expect(await spacesOf('erin')).toEqual(['plan']);
      const people = (await call('admin', 'GET', '/api/people')).body as Array<{
        principal: { principalId: string };
        workspaces: Array<{ workspaceId: string; role: string }>;
      }>;
      expect(
        people.find((p) => p.principal.principalId === 'erin')?.workspaces,
      ).toContainEqual({ workspaceId: carolWs, role: 'editor' });

      // Removing it, then admission, takes effect on the next request.
      await call('admin', 'PUT', `/api/people/erin/workspaces/${carolWs}`, {
        role: null,
      });
      expect(await spacesOf('erin')).not.toContain('plan');
      await admit('erin', false);
      expect((await call('erin', 'GET', '/api/canvas')).status).toBe(403);

      // A revoked person's devices can still be cut off; only by an admin.
      const reset = (by: string, principalId: string) =>
        call(by, 'POST', `/api/people/${principalId}/agent-credentials/reset`);
      expect((await reset('carol', 'erin')).status).toBe(403);
      expect((await reset('admin', 'nobody')).status).toBe(404);
      expect((await reset('admin', 'erin')).status).toBe(204);
    });
  });
}
