// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { interactiveViewResourceSchema } from '@huabu/shared';

import rfsRoutes from './rfs.route.js';
import {
  agenetes,
  EXTERNAL_DRIVER_KIND,
  type AcpWorkloadSpec,
} from '../agent/agenetes/drivers.js';
import interactiveViewRoutes from '../interactive-view/interactive-view.route.js';
import { space, getCanvasStore, resetStorageCache } from '../storage/index.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import { setWorkspacePath } from '../workspace.js';

let workspace: string;

async function buildApp() {
  const app = fastify();
  await app.register(rfsRoutes, { prefix: '/rfs' });
  await app.register(interactiveViewRoutes, {
    prefix: '/interactive-views',
  });
  await app.ready();
  return app;
}

function seedCanvas() {
  getCanvasStore('c1').write({
    canvasId: 'c1',
    title: null,
    version: 1,
    state: {
      nodes: [
        {
          id: 'node-owner',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { threadId: 'thread-owner' },
        },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const ownerSpec: AcpWorkloadSpec = {
    threadId: 'thread-owner',
    kind: EXTERNAL_DRIVER_KIND,
    workloadType: 'Deployment',
    namespace: canvasAcpNamespace('c1'),
    spec: {
      initialPreamble: [],
      binding: {
        profileId: 'profile-test',
        alias: 'Test Agent',
      },
      agentletId: 'agentlet-test',
      recipe: null,
    },
  };
  agenetes.create(ownerSpec);
}

const state = {
  schema: {
    type: 'object',
    properties: {
      codebasePath: { type: 'string', maxLength: 4096 },
      worktreeRoot: { type: 'string', maxLength: 4096 },
    },
    required: ['codebasePath', 'worktreeRoot'],
    additionalProperties: false,
  },
  value: { codebasePath: '', worktreeRoot: '' },
} as const;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'huabu-interactive-view-'));
  resetStorageCache();
  setWorkspacePath(workspace);
  seedCanvas();
});

afterEach(() => {
  agenetes.close('thread-owner');
  resetStorageCache();
  rmSync(workspace, { recursive: true, force: true });
});

describe('Interactive View RFS resources', () => {
  it('creates, discovers, reads, and CAS-updates a View', async () => {
    const app = await buildApp();
    try {
      const uploaded = await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/issue-tracker.html',
        headers: { 'content-type': 'text/html' },
        payload: '<!doctype html><title>Issue Tracker</title>',
      });
      expect(uploaded.statusCode).toBe(201);

      const createdResponse = await app.inject({
        method: 'POST',
        url: '/rfs/c1/interactive-views',
        headers: { 'content-type': 'application/json' },
        payload: {
          rendererArtifact: 'upload/issue-tracker.html',
          viewKey: 'issue-tracker',
          ownerThreadId: 'thread-owner',
          state,
          actions: [{ actionId: 'save-configuration', kind: 'state.replace' }],
          position: { x: 400, y: 200 },
          size: { width: 720, height: 520 },
        },
      });

      expect(createdResponse.statusCode).toBe(201);
      const created = interactiveViewResourceSchema.parse(
        createdResponse.json(),
      );
      expect(created).toMatchObject({
        viewKey: 'issue-tracker',
        definition: {
          ownerThreadId: 'thread-owner',
          state: { value: state.value },
        },
      });
      expect(created.rendererArtifact).toMatch(/\.html$/);

      const renderer = await app.inject({
        method: 'GET',
        url: `/interactive-views/c1/${created.nodeId}/renderer`,
      });
      expect(renderer.statusCode).toBe(200);
      expect(renderer.body).toContain('<title>Issue Tracker</title>');
      expect(renderer.headers['content-security-policy']).toContain(
        "connect-src 'none'",
      );

      const list = await app.inject({
        method: 'GET',
        url: '/rfs/c1/interactive-views?viewKey=issue-tracker',
      });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ views: unknown[] }>().views).toHaveLength(1);

      const read = await app.inject({
        method: 'GET',
        url: `/rfs/c1/interactive-views/${created.nodeId}`,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ revision: created.revision });

      const updatedResponse = await app.inject({
        method: 'PUT',
        url: `/rfs/c1/interactive-views/${created.nodeId}/state`,
        headers: { 'content-type': 'application/json' },
        payload: {
          revision: created.revision,
          value: {
            codebasePath: '/repo',
            worktreeRoot: '/worktrees',
          },
        },
      });
      expect(updatedResponse.statusCode).toBe(200);
      const updated = interactiveViewResourceSchema.parse(
        updatedResponse.json(),
      );
      expect(updated.revision).not.toBe(created.revision);

      const stale = await app.inject({
        method: 'PUT',
        url: `/rfs/c1/interactive-views/${created.nodeId}/state`,
        headers: { 'content-type': 'application/json' },
        payload: {
          revision: created.revision,
          value: { codebasePath: '/stale', worktreeRoot: '/stale' },
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        code: 'view_conflict',
        details: { currentRevision: updated.revision },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects missing renderers and state outside the declared schema', async () => {
    const app = await buildApp();
    try {
      const missingRenderer = await app.inject({
        method: 'POST',
        url: '/rfs/c1/interactive-views',
        headers: { 'content-type': 'application/json' },
        payload: {
          rendererArtifact: 'missing.html',
          ownerThreadId: 'thread-owner',
          state,
          position: { x: 0, y: 0 },
        },
      });
      expect(missingRenderer.statusCode).toBe(400);
      expect(missingRenderer.json()).toMatchObject({
        code: 'renderer_not_found',
      });

      await space('c1').blobs.put('view.html', Buffer.from('<p>view</p>'));
      const invalidState = await app.inject({
        method: 'POST',
        url: '/rfs/c1/interactive-views',
        headers: { 'content-type': 'application/json' },
        payload: {
          rendererArtifact: 'view.html',
          ownerThreadId: 'thread-owner',
          state: {
            ...state,
            value: { ...state.value, extra: true },
          },
          position: { x: 0, y: 0 },
        },
      });
      expect(invalidState.statusCode).toBe(400);
      expect(invalidState.json()).toMatchObject({ code: 'invalid_state' });
    } finally {
      await app.close();
    }
  });

  it('keeps iframe state writes grant-bound while trusted RFS writes remain available', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/read-only.html',
        payload: '<!doctype html><title>Read only</title>',
      });
      const createdResponse = await app.inject({
        method: 'POST',
        url: '/rfs/c1/interactive-views',
        payload: {
          rendererArtifact: 'upload/read-only.html',
          ownerThreadId: 'thread-owner',
          state,
          actions: [],
          position: { x: 0, y: 0 },
        },
      });
      const created = interactiveViewResourceSchema.parse(
        createdResponse.json(),
      );
      const replacement = {
        revision: created.revision,
        value: { codebasePath: '/repo', worktreeRoot: '/worktrees' },
      };

      const iframeWrite = await app.inject({
        method: 'PUT',
        url: `/interactive-views/c1/${created.nodeId}/state`,
        payload: replacement,
      });
      expect(iframeWrite.statusCode).toBe(400);
      expect(iframeWrite.json()).toMatchObject({
        code: 'action_not_granted',
      });

      const trustedWrite = await app.inject({
        method: 'PUT',
        url: `/rfs/c1/interactive-views/${created.nodeId}/state`,
        payload: replacement,
      });
      expect(trustedWrite.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
