// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { migrateSpaceGrants } from './bubble.js';
import { describeSeveralPeople, host } from './multi-user.scenarios.js';
import { storageResourceDirectory } from './resources.js';
import { canvasJsonPath } from '../storage/backends/disk/layout.js';
import {
  closeStorage,
  createSpace,
  getWorkspaceRepository,
  openWorkspace,
  resetStorageCache,
  workspaceDirectory,
} from '../storage/index.js';
import { runInWorkspace } from '../workspace/context.js';
import {
  getProcessWorkspaceHandle,
  initWorkspaceFromEnv,
  setWorkspacePath,
} from '../workspace.js';

import type * as WorkspaceActivationModule from '../workspace-activation.js';

// Folder preparation runs in-process here instead of in its worker.
vi.mock('../workspace-activation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceActivationModule>();
  const { prepareWorkspaceOnDisk } = await import('../workspace-prepare.js');
  const workspace = await import('../workspace.js');
  return {
    ...actual,
    runWorkspacePreparation: async (workspacePath: string) => {
      prepareWorkspaceOnDisk(workspacePath);
    },
    prepareWorkspacePath: async (newPath: string) => {
      const resolved = workspace.resolveWorkspacePath(newPath);
      prepareWorkspaceOnDisk(resolved);
      return resolved;
    },
    activateWorkspacePath: async (newPath: string) => {
      const reservation = workspace.beginWorkspaceActivation(newPath);
      try {
        prepareWorkspaceOnDisk(reservation.workspacePath);
        reservation.commit();
      } finally {
        reservation.release();
      }
    },
  };
});

let tmp: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-multi-user-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = join(tmp, 'data');
  mkdirSync(join(tmp, 'server'));
  resetStorageCache();
  // The Server's own Workspace, where the administrator lands.
  setWorkspacePath(join(tmp, 'server'));
});
afterEach(async () => {
  await closeStorage();
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

describeSeveralPeople('Disk', () => tmp);

it('lists only allowed Workspace manifests even when an unrelated manifest is corrupt', async () => {
  const { call, workspaceOf } = await host();
  const carolWs = await workspaceOf('carol');
  const side = (
    await call('carol', 'POST', '/api/workspaces', { name: 'Side' })
  ).body.workspaceId as string;
  const expected = (await getWorkspaceRepository().list())
    .filter((w) => [carolWs, side].includes(w.workspaceId))
    .map((w) => w.workspaceId);
  writeFileSync(join(tmp, 'server', '.workspace.json'), '{broken');
  const response = await call('carol', 'GET', '/api/workspaces');
  expect(response.status).toBe(200);
  expect(
    response.body.map((w: { workspaceId: string }) => w.workspaceId),
  ).toEqual(expected);
  expect(
    (await call('admin', 'GET', '/api/workspaces')).status,
  ).toBeGreaterThanOrEqual(500);
});

it('preserves legacy ownership while a registered Disk Workspace is offline, then migrates it on recovery', async () => {
  const store = new InMemoryBubbleStore();
  await createSpace('canvas-legacy', 'Legacy');
  await store.grants.add({
    target: { type: 'huabu.space', id: 'canvas-legacy' },
    principalId: 'carol',
    role: 'huabu.space.owner',
    grantedByPrincipalId: null,
  });
  renameSync(join(tmp, 'server'), join(tmp, 'offline'));
  await migrateSpaceGrants(store, storageResourceDirectory);
  expect((await store.grants.list()).map((grant) => grant.target)).toEqual([
    { type: 'huabu.space', id: 'canvas-legacy' },
  ]);
  renameSync(join(tmp, 'offline'), join(tmp, 'server'));
  await migrateSpaceGrants(store, storageResourceDirectory);
  expect((await store.grants.list()).map((grant) => grant.target)).toEqual([
    { type: 'huabu.space', id: expect.stringMatching(/:canvas-legacy$/) },
  ]);
});

it('propagates a Space read failure without removing its legacy ownership grant', async () => {
  const store = new InMemoryBubbleStore();
  await createSpace('canvas-legacy', 'Legacy');
  await store.grants.add({
    target: { type: 'huabu.space', id: 'canvas-legacy' },
    principalId: 'carol',
    role: 'huabu.space.owner',
    grantedByPrincipalId: null,
  });
  const recordPath = canvasJsonPath('canvas-legacy');
  rmSync(recordPath);
  mkdirSync(recordPath);
  await expect(
    migrateSpaceGrants(store, storageResourceDirectory),
  ).rejects.toThrow();
  expect((await store.grants.list()).map((grant) => grant.target)).toEqual([
    { type: 'huabu.space', id: 'canvas-legacy' },
  ]);
});

it('keeps every Bubble member in the Workspace managed mode locks', async () => {
  const serverWs = getProcessWorkspaceHandle()!.workspaceId;
  const previous = process.env.HUABU_WORKSPACE;
  process.env.HUABU_WORKSPACE = join(tmp, 'locked');
  mkdirSync(join(tmp, 'locked'));
  try {
    initWorkspaceFromEnv();
    const locked = getProcessWorkspaceHandle()!.workspaceId;
    const registered = async () =>
      (await getWorkspaceRepository().list()).map((w) => w.workspaceId).sort();
    const before = await registered();
    const { call, store, workspaceOf } = await host();

    // No personal Workspace is made beside the locked one.
    expect(await workspaceOf('carol')).toBe(locked);
    expect(await registered()).toEqual(before);

    // A grant elsewhere neither moves a member nor lets them switch there.
    await store.grants.add({
      target: { type: 'huabu.workspace', id: serverWs },
      principalId: 'dave',
      role: 'huabu.workspace.owner',
      grantedByPrincipalId: null,
    });
    expect(await workspaceOf('dave')).toBe(locked);
    expect(
      (await call('dave', 'POST', `/api/workspaces/${serverWs}/activate`))
        .status,
    ).toBe(403);
    expect(await workspaceOf('dave')).toBe(locked);
    expect(
      (await call('dave', 'GET', '/api/workspace')).body.capabilities,
    ).toMatchObject({ canChangeWorkspace: false });

    // An administrator sees only the locked Workspace, as in local mode.
    expect(
      (await call('admin', 'GET', '/api/workspaces')).body.map(
        (w: { workspaceId: string }) => w.workspaceId,
      ),
    ).toEqual([locked]);
  } finally {
    if (previous === undefined) delete process.env.HUABU_WORKSPACE;
    else process.env.HUABU_WORKSPACE = previous;
    initWorkspaceFromEnv();
  }
});

it("moves the process Workspace for a Bubble administrator's folder change, and only for that", async () => {
  const serverWs = getProcessWorkspaceHandle()!.workspaceId;
  const { call, workspaceOf } = await host();
  const mine = (
    await call('admin', 'POST', '/api/workspaces', { name: 'Mine' })
  ).body.workspaceId as string;
  await call('admin', 'POST', `/api/workspaces/${mine}/activate`);
  expect(await workspaceOf('admin')).toBe(mine);

  // Registering their current Workspace's moved folder moves nothing else.
  const moved = join(tmp, 'moved');
  renameSync(workspaceDirectory(mine)!, moved);
  expect(
    (await call('admin', 'POST', '/api/workspaces', { path: moved })).status,
  ).toBeLessThan(300);
  expect(getProcessWorkspaceHandle()!.workspaceId).toBe(serverWs);
  expect(workspaceDirectory(mine)).toBe(moved);

  // Picking a folder moves the process there, and its picker with it.
  mkdirSync(join(tmp, 'picked'));
  const put = await call('admin', 'PUT', '/api/workspace', {
    path: join(tmp, 'picked'),
  });
  expect(put.status).toBe(200);
  const picked = getProcessWorkspaceHandle()!.workspaceId;
  expect(picked).not.toBe(serverWs);
  expect(put.body.workspaceId).toBe(picked);
  expect(await workspaceOf('admin')).toBe(picked);
});

it("resolves Spaces of the call's own Workspace without looking it up again", async () => {
  const workspace = getProcessWorkspaceHandle()!;
  const ids = ['one', 'two', 'three'];
  for (const id of ids) await createSpace(id, id);
  const scope = await openWorkspace(workspace);
  const get = vi.spyOn(getWorkspaceRepository(), 'get');
  try {
    const parents = await runInWorkspace(scope, () =>
      Promise.all(
        ids.map((id) =>
          storageResourceDirectory.spaceParent(workspace.workspaceId, id),
        ),
      ),
    );
    expect(parents).toEqual(
      ids.map(() => ({ type: 'workspace', id: workspace.workspaceId })),
    );
    expect(get).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
  }
});
