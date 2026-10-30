// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInWorkspace } from './context.js';
import { workspaceScopedRoutes } from './scoped-routes.js';
import { buildReachbackEnv } from '../agent/acp/reachback-env.js';
import { registerIdentity } from '../identity/http.js';
import { resetStorageCache } from '../storage/index.js';
import { createWorkspace } from '../workspace-activation.js';
import { registerWorkspaceRequiredGuard } from '../workspace-required.js';
import { getWorkspaceHandle, setWorkspacePath } from '../workspace.js';

import type { FastifyPluginAsync } from 'fastify';

let tmp: string;
let previousDataDir: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-scoped-routes-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = join(tmp, 'data');
  mkdirSync(join(tmp, 'server'));
  resetStorageCache();
  setWorkspacePath(join(tmp, 'server'));
});
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Workspace-scoped routes', () => {
  it('binds Bubble machine requests to the process Workspace unless the URL names another', async () => {
    const other = await createWorkspace('Other');
    const app = Fastify();
    registerIdentity(app, {
      service: {
        provider: 'bubble',
        challenge: 'Bearer',
        authenticate: async () => null,
      },
      getConnectionToken: () => 'machine-secret',
    });
    registerWorkspaceRequiredGuard(app);
    const routes: FastifyPluginAsync = async (scoped) => {
      scoped.get('/:canvasId/where', async () => ({
        workspaceId: getWorkspaceHandle()?.workspaceId,
      }));
    };
    await app.register(routes, { prefix: '/api/rfs' });
    await app.register(workspaceScopedRoutes(routes), {
      prefix: '/api/rfs/w/:workspaceId',
    });
    try {
      for (const [url, workspaceId] of [
        ['/api/rfs/a/where', getWorkspaceHandle()?.workspaceId],
        [`/api/rfs/w/${other.workspaceId}/a/where`, other.workspaceId],
      ]) {
        const response = await app.inject({
          url,
          headers: { authorization: 'Bearer machine-secret' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ workspaceId });
      }
    } finally {
      await app.close();
    }
  });
  it('run each call in the Workspace their prefix names', async () => {
    const other = await createWorkspace('Other');
    const app = Fastify();
    const routes: FastifyPluginAsync = async (scoped) => {
      scoped.get('/where', async () => ({
        workspaceId: getWorkspaceHandle()?.workspaceId,
      }));
    };
    await app.register(routes, { prefix: '/plain' });
    await app.register(workspaceScopedRoutes(routes), {
      prefix: '/w/:workspaceId',
    });

    const processActive = getWorkspaceHandle()?.workspaceId;
    expect((await app.inject('/plain/where')).json().workspaceId).toBe(
      processActive,
    );
    expect(
      (await app.inject(`/w/${other.workspaceId}/where`)).json().workspaceId,
    ).toBe(other.workspaceId);
    expect((await app.inject('/w/no-such-workspace/where')).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it('names the Workspace a run starts in in its reachback URL', async () => {
    const other = await createWorkspace('Other');
    const previous = process.env.HUABU_PUBLIC_ORIGIN;
    process.env.HUABU_PUBLIC_ORIGIN = 'https://huabu.example.com';
    try {
      const env = runInWorkspace({ handle: other, path: null }, () =>
        buildReachbackEnv('thread-1', 'canvas-1'),
      );
      expect(env).toEqual({
        HUABU_RFS_URL: `https://huabu.example.com/api/rfs/w/${other.workspaceId}/canvas-1`,
        HUABU_THREAD_ID: 'thread-1',
      });
    } finally {
      if (previous === undefined) delete process.env.HUABU_PUBLIC_ORIGIN;
      else process.env.HUABU_PUBLIC_ORIGIN = previous;
    }
  });
});
