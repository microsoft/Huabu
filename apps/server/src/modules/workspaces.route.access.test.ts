// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { host } from './identity/multi-user.scenarios.js';
import {
  closeStorage,
  getWorkspaceRepository,
  resetStorageCache,
} from './storage/index.js';
import { setWorkspacePath } from './workspace.js';
import workspacesRoutes from './workspaces.route.js';
import { registerLocalTestIdentity } from '../test-support/local-identity.js';

import type * as WorkspaceActivationModule from './workspace-activation.js';

// Only replace the subprocess boundary. The real preparation/migrations,
// files, registry, Bubble policy and HTTP routes remain inside this test.
vi.mock('./workspace-activation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceActivationModule>();
  const { prepareWorkspaceOnDisk } = await import('./workspace-prepare.js');
  return {
    ...actual,
    // Keep live class bindings through the Workspace/preparation import
    // cycle; eagerly spreading a not-yet-initialized re-export loses it.
    get WorkspaceActivationInProgressError() {
      return actual.WorkspaceActivationInProgressError;
    },
    get WorkspaceActivationTimeoutError() {
      return actual.WorkspaceActivationTimeoutError;
    },
    prepareWorkspacePath: async (workspacePath: string) => {
      prepareWorkspaceOnDisk(workspacePath);
      return workspacePath;
    },
  };
});

let root: string;
let previousDataDir: string | undefined;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'huabu-folder-access-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = path.join(root, 'data');
  resetStorageCache();
  setWorkspacePath(path.join(root, 'server'));
});
afterEach(async () => {
  await closeStorage();
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  resetStorageCache();
  rmSync(root, { recursive: true, force: true });
});

it.each([
  'parent',
  'child',
  'missing-child',
  'symlink',
  'symlink-child',
] as const)(
  'refuses a foreign Workspace %s before preparation or manifest writes',
  async (kind) => {
    const { call, workspaceOf } = await host();
    await workspaceOf('dave');
    const foreign = path.join(root, 'enclosing', 'foreign');
    const made = await call('carol', 'POST', '/api/workspaces', {
      path: foreign,
      name: 'Carol private folder',
    });
    expect(made.status).toBe(201);
    const legacy = path.join(foreign, 'legacy-space');
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, 'canvas.json'), '{"private":true}');
    const alias = path.join(root, 'alias');
    symlinkSync(foreign, alias, 'dir');
    const requested = {
      parent: path.dirname(foreign),
      child: legacy,
      'missing-child': path.join(foreign, 'missing', 'descendant'),
      symlink: alias,
      'symlink-child': path.join(alias, 'missing', 'descendant'),
    }[kind];
    const registeredBefore = await getWorkspaceRepository().list();
    const manifestBefore = readFileSync(path.join(foreign, '.workspace.json'));

    const denied = await call('dave', 'POST', '/api/workspaces', {
      path: requested,
    });
    expect(denied).toEqual({
      status: 404,
      body: { message: 'Workspace not found' },
    });
    expect(readFileSync(path.join(foreign, '.workspace.json'))).toEqual(
      manifestBefore,
    );
    expect(readFileSync(path.join(legacy, 'canvas.json'), 'utf8')).toBe(
      '{"private":true}',
    );
    expect(existsSync(path.join(legacy, 'space.json'))).toBe(false);
    if (kind !== 'symlink')
      expect(existsSync(path.join(requested, '.workspace.json'))).toBe(false);
    if (kind.includes('missing') || kind === 'symlink-child')
      expect(existsSync(requested)).toBe(false);
    expect(await getWorkspaceRepository().list()).toEqual(registeredBefore);
  },
);

it('keeps unrelated debug folders and authorized nested folders available', async () => {
  const { call, store, workspaceOf } = await host();
  await workspaceOf('dave');
  const foreign = path.join(root, 'carol');
  const made = await call('carol', 'POST', '/api/workspaces', {
    path: foreign,
  });
  expect(made.status).toBe(201);
  await store.grants.add({
    target: { type: 'huabu.workspace', id: made.body.workspaceId },
    principalId: 'dave',
    role: 'huabu.workspace.viewer',
    grantedByPrincipalId: 'carol',
  });
  expect(
    (await call('dave', 'POST', '/api/workspaces', { path: foreign })).status,
  ).toBe(200);
  const child = path.join(foreign, 'new-folder');
  expect(
    (await call('dave', 'POST', '/api/workspaces', { path: child })).status,
  ).toBe(404);
  expect(existsSync(child)).toBe(false);
  expect(
    (await call('carol', 'POST', '/api/workspaces', { path: child })).status,
  ).toBe(201);
  expect(
    (
      await call('dave', 'POST', '/api/workspaces', {
        path: path.join(root, 'unregistered'),
      })
    ).status,
  ).toBe(201);
});

it('checks registered path ownership without reading a denied manifest', async () => {
  const { call, workspaceOf } = await host();
  await workspaceOf('dave');
  const foreign = path.join(root, 'carol');
  expect(
    (await call('carol', 'POST', '/api/workspaces', { path: foreign })).status,
  ).toBe(201);
  const alias = path.join(root, 'alias');
  symlinkSync(foreign, alias, 'dir');
  writeFileSync(path.join(foreign, '.workspace.json'), '{corrupt');
  for (const requested of [foreign, alias, path.join(alias, 'missing')]) {
    expect(
      (await call('dave', 'POST', '/api/workspaces', { path: requested }))
        .status,
    ).toBe(404);
  }
  expect(readFileSync(path.join(foreign, '.workspace.json'), 'utf8')).toBe(
    '{corrupt',
  );
});

it('keeps damaged foreign directory paths out of adoption errors', async () => {
  const { call, workspaceOf } = await host();
  await workspaceOf('dave');
  const foreign = path.join(root, 'private-carol-directory');
  expect(
    (await call('carol', 'POST', '/api/workspaces', { path: foreign })).status,
  ).toBe(201);
  rmSync(foreign, { recursive: true });
  symlinkSync(foreign, foreign, 'dir');
  const failed = await call('dave', 'POST', '/api/workspaces', {
    path: path.join(root, 'unrelated'),
  });
  expect(failed).toEqual({
    status: 400,
    body: { message: 'A registered Workspace directory could not be resolved' },
  });
  expect(existsSync(path.join(root, 'unrelated'))).toBe(false);
});

it('authorizes a copied or moved manifest identity before preparing its new path', async () => {
  const { call, workspaceOf } = await host();
  await workspaceOf('dave');
  const foreign = path.join(root, 'carol');
  expect(
    (await call('carol', 'POST', '/api/workspaces', { path: foreign })).status,
  ).toBe(201);
  mkdirSync(path.join(foreign, 'legacy'));
  writeFileSync(
    path.join(foreign, 'legacy', 'canvas.json'),
    'private legacy data',
  );
  const copied = path.join(root, 'copied');
  const moved = path.join(root, 'moved');
  cpSync(foreign, copied, { recursive: true });
  renameSync(foreign, moved);
  for (const requested of [copied, moved]) {
    const manifest = readFileSync(path.join(requested, '.workspace.json'));
    expect(
      (await call('dave', 'POST', '/api/workspaces', { path: requested }))
        .status,
    ).toBe(404);
    expect(readFileSync(path.join(requested, '.workspace.json'))).toEqual(
      manifest,
    );
    expect(
      readFileSync(path.join(requested, 'legacy', 'canvas.json'), 'utf8'),
    ).toBe('private legacy data');
    expect(existsSync(path.join(requested, 'legacy', 'space.json'))).toBe(
      false,
    );
  }
});

it('preserves local-mode adoption of folders overlapping its own registered Workspace', async () => {
  const app = Fastify();
  registerLocalTestIdentity(app);
  await app.register(workspacesRoutes, { prefix: '/api/workspaces' });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { path: path.join(root, 'server', 'local-folder') },
      remoteAddress: '127.0.0.1',
    });
    expect(response.statusCode).toBe(201);
    expect(
      existsSync(path.join(root, 'server', 'local-folder', '.workspace.json')),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
