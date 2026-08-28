// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({
  configured: false,
  managed: false,
  workspaceId: '00000000-0000-4000-8000-000000000001',
  path: '/tmp/sediment-workspace-route',
  name: 'sediment-workspace-route',
}));

vi.mock('./workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceModule>();
  return {
    ...actual,
    getWorkspaceHandle: () =>
      workspaceState.configured
        ? {
            workspaceId: workspaceState.workspaceId,
            name: workspaceState.name,
          }
        : null,
    getWorkspacePath: () => workspaceState.path,
    isManagedMode: () => workspaceState.managed,
    isWorkspaceConfigured: () => workspaceState.configured,
  };
});

vi.mock('./workspace-activation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceActivationModule>();
  return {
    ...actual,
    activateWorkspacePath: vi.fn(),
  };
});

vi.mock('./storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return {
    ...actual,
    getStructuredStore: vi.fn(),
  };
});

import { getStructuredStore } from './storage/index.js';
import { activateWorkspacePath } from './workspace-activation.js';
import workspaceRoutes from './workspace.route.js';

import type * as StorageModule from './storage/index.js';
import type * as WorkspaceActivationModule from './workspace-activation.js';
import type * as WorkspaceModule from './workspace.js';

const worldId = vi.fn<() => Promise<string>>();
const spaces = vi.fn(() => ({ list: vi.fn(), worldId }));

async function buildApp() {
  const app = fastify();
  await app.register(workspaceRoutes, { prefix: '/workspace' });
  await app.ready();
  return app;
}

beforeEach(() => {
  workspaceState.configured = false;
  workspaceState.managed = false;
  workspaceState.workspaceId = '00000000-0000-4000-8000-000000000001';
  workspaceState.path = '/tmp/sediment-workspace-route';
  workspaceState.name = 'sediment-workspace-route';
  worldId.mockReset().mockResolvedValue('world-id');
  spaces.mockClear();
  vi.mocked(getStructuredStore)
    .mockReset()
    .mockReturnValue({ spaces } as unknown as ReturnType<
      typeof getStructuredStore
    >);
  vi.mocked(activateWorkspacePath)
    .mockReset()
    .mockImplementation(async (nextPath) => {
      workspaceState.configured = true;
      workspaceState.path = nextPath;
      workspaceState.name = nextPath.split('/').filter(Boolean).at(-1) ?? '';
    });
});

describe('workspace Space repository integration', () => {
  it('reads the configured World id from the Space repository', async () => {
    workspaceState.configured = true;
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/workspace' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        configured: true,
        workspaceId: '00000000-0000-4000-8000-000000000001',
        worldCanvasId: 'world-id',
      });
      expect(spaces).toHaveBeenCalledTimes(1);
      expect(worldId).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('does not resolve a Space repository before a Workspace is configured', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/workspace' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        configured: false,
        workspaceId: null,
        worldCanvasId: null,
      });
      expect(getStructuredStore).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('awaits the World id after activating a Workspace', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/workspace',
        payload: { path: '/tmp/new-workspace' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        configured: true,
        workspaceId: '00000000-0000-4000-8000-000000000001',
        path: '/tmp/new-workspace',
        name: 'new-workspace',
        worldCanvasId: 'world-id',
      });
      expect(activateWorkspacePath).toHaveBeenCalledWith('/tmp/new-workspace');
      expect(worldId).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('keeps post-activation World failures inside the PUT error path', async () => {
    worldId.mockRejectedValueOnce(new Error('World record is corrupt'));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/workspace',
        payload: { path: '/tmp/new-workspace' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ message: 'World record is corrupt' });
    } finally {
      await app.close();
    }
  });

  it('keeps managed-mode path privacy while returning the stable identity', async () => {
    workspaceState.configured = true;
    workspaceState.managed = true;
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/workspace' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        mode: 'managed',
        configured: true,
        workspaceId: '00000000-0000-4000-8000-000000000001',
        path: null,
        name: 'sediment-workspace-route',
      });
    } finally {
      await app.close();
    }
  });
});
