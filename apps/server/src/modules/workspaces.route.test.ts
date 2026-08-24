// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FIRST_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';
const NEW_ID = '00000000-0000-4000-8000-000000000003';

interface TestHandle {
  workspaceId: string;
  workspacePath: string;
  name: string;
}

const testState = vi.hoisted(() => ({
  managed: false,
  active: null as TestHandle | null,
  handles: [] as TestHandle[],
}));

const storageMocks = vi.hoisted(() => ({
  resetStorageCache: vi.fn(),
}));

const activationMocks = vi.hoisted(() => ({
  activateWorkspacePath: vi.fn<(path: string) => Promise<void>>(),
  prepareWorkspacePath: vi.fn<(path: string) => Promise<string>>(),
}));

const preprocessingMocks = vi.hoisted(() => ({
  resetPreprocessDispatcher: vi.fn(),
}));

const repository = vi.hoisted(() => ({
  list: vi.fn(() => testState.handles),
  get: vi.fn(
    (workspaceId: string) =>
      testState.handles.find(
        (workspace) => workspace.workspaceId === workspaceId,
      ) ?? null,
  ),
  getByPath: vi.fn(
    (workspacePath: string) =>
      testState.handles.find(
        (workspace) => workspace.workspacePath === workspacePath,
      ) ?? null,
  ),
  open: vi.fn((workspacePath: string) => {
    const workspace = {
      workspaceId: '00000000-0000-4000-8000-000000000003',
      workspacePath,
      name: workspacePath.split('/').filter(Boolean).at(-1) ?? 'Workspace',
    };
    testState.handles.push(workspace);
    return workspace;
  }),
  rename: vi.fn((workspaceId: string, name: string) => {
    const index = testState.handles.findIndex(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (index < 0) return null;
    const workspace = { ...testState.handles[index], name } as TestHandle;
    testState.handles[index] = workspace;
    return workspace;
  }),
  remove: vi.fn((workspaceId: string) => {
    const index = testState.handles.findIndex(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (index < 0) return false;
    testState.handles.splice(index, 1);
    return true;
  }),
}));

vi.mock('./storage/index.js', () => ({
  getWorkspaceRepository: () => repository,
  resetStorageCache: storageMocks.resetStorageCache,
}));

vi.mock('./workspace.js', () => ({
  getWorkspaceHandle: () => testState.active,
  isManagedMode: () => testState.managed,
  resolveWorkspacePath: (workspacePath: string) => workspacePath,
  updateActiveWorkspaceHandle: (workspace: TestHandle) => {
    if (testState.active?.workspaceId !== workspace.workspaceId) return false;
    testState.active = workspace;
    return true;
  },
}));

vi.mock('./workspace-activation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceActivationModule>();
  return {
    ...actual,
    activateWorkspacePath: activationMocks.activateWorkspacePath,
    prepareWorkspacePath: activationMocks.prepareWorkspacePath,
  };
});

vi.mock('./preprocessing/index.js', () => ({
  resetPreprocessDispatcher: preprocessingMocks.resetPreprocessDispatcher,
}));

import workspacesRoutes from './workspaces.route.js';

import type * as WorkspaceActivationModule from './workspace-activation.js';

async function buildApp() {
  const app = fastify();
  await app.register(workspacesRoutes, { prefix: '/workspaces' });
  await app.ready();
  return app;
}

beforeEach(() => {
  testState.managed = false;
  testState.handles = [
    {
      workspaceId: FIRST_ID,
      workspacePath: '/tmp/first',
      name: 'First',
    },
    {
      workspaceId: SECOND_ID,
      workspacePath: '/tmp/second',
      name: 'Second',
    },
  ];
  testState.active = testState.handles[0] ?? null;
  vi.clearAllMocks();
  activationMocks.prepareWorkspacePath.mockImplementation(async (path) => path);
  activationMocks.activateWorkspacePath.mockImplementation(async (path) => {
    testState.active = repository.getByPath(path);
  });
});

describe('plural Workspace management routes', () => {
  it('lists registered Workspaces and marks the active one', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/workspaces' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        {
          workspaceId: FIRST_ID,
          name: 'First',
          path: '/tmp/first',
          active: true,
        },
        {
          workspaceId: SECOND_ID,
          name: 'Second',
          path: '/tmp/second',
          active: false,
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('registers and prepares a Workspace without activating it', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/workspaces',
        payload: { path: '/tmp/new', name: 'New Workspace' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        workspaceId: NEW_ID,
        name: 'New Workspace',
        path: '/tmp/new',
        active: false,
      });
      expect(activationMocks.prepareWorkspacePath).toHaveBeenCalledWith(
        '/tmp/new',
      );
      expect(testState.active?.workspaceId).toBe(FIRST_ID);
    } finally {
      await app.close();
    }
  });

  it('activates a registered Workspace by stable id', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/workspaces/${SECOND_ID}/activate`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspaceId: SECOND_ID,
        active: true,
      });
      expect(activationMocks.activateWorkspacePath).toHaveBeenCalledWith(
        '/tmp/second',
      );
      expect(storageMocks.resetStorageCache).toHaveBeenCalledOnce();
      expect(
        preprocessingMocks.resetPreprocessDispatcher,
      ).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('renames a Workspace and refreshes active metadata', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: `/workspaces/${FIRST_ID}`,
        payload: { name: 'Primary' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspaceId: FIRST_ID,
        name: 'Primary',
        active: true,
      });
      expect(testState.active?.name).toBe('Primary');
    } finally {
      await app.close();
    }
  });

  it('unregisters an inactive Workspace but protects the active one', async () => {
    const app = await buildApp();
    try {
      const activeResponse = await app.inject({
        method: 'DELETE',
        url: `/workspaces/${FIRST_ID}`,
      });
      expect(activeResponse.statusCode).toBe(409);

      const inactiveResponse = await app.inject({
        method: 'DELETE',
        url: `/workspaces/${SECOND_ID}`,
      });
      expect(inactiveResponse.statusCode).toBe(204);
      expect(repository.get(SECOND_ID)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('narrows a managed deployment to its own Workspace and rejects mutations', async () => {
    testState.managed = true;
    const app = await buildApp();
    try {
      // Registrations left in the data directory by a free-mode session are
      // unaddressable here, so listing them would leak host folder names
      // through the very API that redacts host paths.
      const list = await app.inject({ method: 'GET', url: '/workspaces' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([
        {
          workspaceId: FIRST_ID,
          name: 'First',
          path: null,
          active: true,
        },
      ]);

      const other = await app.inject({
        method: 'GET',
        url: `/workspaces/${SECOND_ID}`,
      });
      expect(other.statusCode).toBe(404);

      const create = await app.inject({
        method: 'POST',
        url: '/workspaces',
        payload: { path: '/tmp/new' },
      });
      expect(create.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('validates ids and reports unknown Workspaces', async () => {
    const app = await buildApp();
    try {
      const invalid = await app.inject({
        method: 'GET',
        url: '/workspaces/not-a-uuid',
      });
      expect(invalid.statusCode).toBe(400);

      const missing = await app.inject({
        method: 'GET',
        url: '/workspaces/00000000-0000-4000-8000-000000000099',
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
