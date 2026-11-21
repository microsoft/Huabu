// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';

import { createNamedWorkspace } from './storage/storage.js';
import {
  mountTestWorkspace,
  type MountedTestStorage,
} from './storage/testing.js';
import { getWorkspaceHandle } from './workspace.js';
import workspacesRoutes from './workspaces.route.js';
import { registerLocalTestIdentity } from '../test-support/local-identity.js';

import type { WorkspaceDescriptor } from '@huabu/shared';

let mounted: MountedTestStorage | null = null;

afterEach(async () => {
  await mounted?.close();
  mounted = null;
});

/**
 * Local SQLite keeps several Workspaces as rows, for one local person. Each
 * row is counted where it is, without switching to it, and nobody has a role:
 * local access is not decided per Workspace.
 */
it('counts each local SQL Workspace’s Spaces and gives no role', async () => {
  mounted = await mountTestWorkspace({
    structured: { kind: 'sqlite' },
    blobs: { kind: 'disk' },
  });
  const first = getWorkspaceHandle();
  if (!first) throw new Error('Expected an active Workspace');
  const spaces = mounted.storage.structured.spaces();
  await spaces.create({ canvasId: 'plans', title: 'Plans' });
  await spaces.create({ canvasId: 'notes', title: 'Notes' });
  const second = await createNamedWorkspace('Second');

  const app = Fastify();
  registerLocalTestIdentity(app);
  await app.register(workspacesRoutes, { prefix: '/workspaces' });
  try {
    const listed = await app.inject({ method: 'GET', url: '/workspaces' });
    expect(listed.statusCode).toBe(200);
    const byId = Object.fromEntries(
      (listed.json() as WorkspaceDescriptor[]).map((workspace) => [
        workspace.workspaceId,
        workspace,
      ]),
    );
    expect(byId[first.workspaceId]).toEqual({
      workspaceId: first.workspaceId,
      name: first.name,
      path: null,
      active: true,
      canManage: true,
      // The hidden World is not one of them.
      spaceCount: 2,
    });
    expect(byId[second.workspaceId]).toEqual({
      workspaceId: second.workspaceId,
      name: 'Second',
      path: null,
      active: false,
      canManage: true,
      spaceCount: 0,
    });
    // Counting another Workspace left the active one where it was.
    expect(getWorkspaceHandle()?.workspaceId).toBe(first.workspaceId);
  } finally {
    await app.close();
  }
});

it('makes one local SQL Workspace for a create retried with its request ID', async () => {
  mounted = await mountTestWorkspace({
    structured: { kind: 'sqlite' },
    blobs: { kind: 'disk' },
  });
  const app = Fastify();
  registerLocalTestIdentity(app);
  await app.register(workspacesRoutes, { prefix: '/workspaces' });
  try {
    const create = () =>
      app.inject({
        method: 'POST',
        url: '/workspaces',
        payload: { name: 'Work log', requestId: 'local-create-1' },
      });
    const first = await create();
    expect(first.statusCode).toBe(201);
    const retried = await create();
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(first.json());
    const listed = (
      await app.inject({ method: 'GET', url: '/workspaces' })
    ).json() as WorkspaceDescriptor[];
    expect(listed.filter((w) => w.name === 'Work log')).toHaveLength(1);
  } finally {
    await app.close();
  }
});
