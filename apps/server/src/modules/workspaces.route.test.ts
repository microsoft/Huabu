// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FIRST_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';
const NEW_ID = '00000000-0000-4000-8000-000000000003';

/** Portable identity, as the port defines it — no path. */
interface TestHandle {
  workspaceId: string;
  name: string;
}

/** One registered member: identity plus the directory backing it. */
interface TestMember extends TestHandle {
  workspacePath: string;
}

function handleOf({ workspaceId, name }: TestMember): TestHandle {
  return { workspaceId, name };
}

const testState = vi.hoisted(() => ({
  managed: false,
  active: null as TestHandle | null,
  activePath: null as string | null,
  members: [] as TestMember[],
  diskIdentities: [] as TestMember[],
  registryInitialized: true,
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
  list: vi.fn(async () =>
    testState.members.map(({ workspaceId, name }) => ({ workspaceId, name })),
  ),
  get: vi.fn(async (workspaceId: string) => {
    const member = testState.members.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    return member
      ? { workspaceId: member.workspaceId, name: member.name }
      : null;
  }),
  rename: vi.fn(async (workspaceId: string, name: string) => {
    const index = testState.members.findIndex(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    if (index < 0) return null;
    const member = { ...testState.members[index], name } as TestMember;
    testState.members[index] = member;
    return { workspaceId: member.workspaceId, name: member.name };
  }),
  remove: vi.fn(async (workspaceId: string) => {
    const index = testState.members.findIndex(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    if (index < 0) return false;
    testState.members.splice(index, 1);
    return true;
  }),
}));

/** The materialization tier the composition root exposes beside the port. */
const locatorMocks = vi.hoisted(() => ({
  workspaceDirectory: vi.fn(
    (workspaceId: string) =>
      testState.members.find(
        (candidate) => candidate.workspaceId === workspaceId,
      )?.workspacePath ?? null,
  ),
  workspaceAtDirectory: vi.fn((workspacePath: string) => {
    const member = testState.members.find(
      (candidate) => candidate.workspacePath === workspacePath,
    );
    return member
      ? { workspaceId: member.workspaceId, name: member.name }
      : null;
  }),
  ensureWorkspaceManifestOnDisk: vi.fn((workspacePath: string) => {
    let member = testState.diskIdentities.find(
      (candidate) => candidate.workspacePath === workspacePath,
    );
    if (!member) {
      member = {
        workspaceId: NEW_ID,
        workspacePath,
        name: workspacePath.split('/').filter(Boolean).at(-1) ?? 'Workspace',
      };
      testState.diskIdentities.push(member);
    }
    return { schemaVersion: 1, ...handleOf(member) };
  }),
  workspaceIdentityOnDisk: vi.fn((workspacePath: string) => {
    const member = testState.diskIdentities.find(
      (candidate) => candidate.workspacePath === workspacePath,
    );
    return member ? handleOf(member) : null;
  }),
  adoptWorkspaceDirectory: vi.fn((workspacePath: string) => {
    const identity = locatorMocks.ensureWorkspaceManifestOnDisk(workspacePath);
    const member: TestMember = {
      workspaceId: identity.workspaceId,
      name: identity.name,
      workspacePath,
    };
    testState.members = testState.members.filter(
      (candidate) =>
        candidate.workspaceId !== member.workspaceId &&
        candidate.workspacePath !== workspacePath,
    );
    testState.members.unshift(member);
    testState.registryInitialized = true;
    return { workspaceId: member.workspaceId, name: member.name };
  }),
}));

vi.mock('./storage/index.js', () => ({
  getWorkspaceRepository: () => repository,
  hasWorkspaceRegistry: () => testState.registryInitialized,
  resetStorageCache: storageMocks.resetStorageCache,
  adoptWorkspaceDirectory: locatorMocks.adoptWorkspaceDirectory,
  ensureWorkspaceManifestOnDisk: locatorMocks.ensureWorkspaceManifestOnDisk,
  workspaceAtDirectory: locatorMocks.workspaceAtDirectory,
  workspaceDirectory: locatorMocks.workspaceDirectory,
  workspaceIdentityOnDisk: locatorMocks.workspaceIdentityOnDisk,
}));

vi.mock('./workspace.js', () => ({
  commitWorkspacePath: (workspacePath: string) => {
    testState.active = locatorMocks.adoptWorkspaceDirectory(workspacePath);
    testState.activePath = workspacePath;
  },
  getWorkspaceHandle: () => testState.active,
  getWorkspacePath: () => {
    if (!testState.activePath) throw new Error('No active Workspace path');
    return testState.activePath;
  },
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
  testState.registryInitialized = true;
  testState.members = [
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
  testState.diskIdentities = testState.members.map((member) => ({ ...member }));
  const first = testState.members[0];
  testState.active = first ? handleOf(first) : null;
  testState.activePath = first?.workspacePath ?? null;
  vi.clearAllMocks();
  activationMocks.prepareWorkspacePath.mockImplementation(async (path) => path);
  activationMocks.activateWorkspacePath.mockImplementation(async (path) => {
    testState.active = locatorMocks.workspaceAtDirectory(path);
    testState.activePath = path;
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

  it('imports the deprecated desktop store before the first list', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'huabu-route-legacy-store-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const deleted = path.join(root, 'deleted');
    mkdirSync(first);
    mkdirSync(second);
    const legacyFile = path.join(root, 'workspace.json');
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: second, recent: [second, first, deleted] }),
      'utf8',
    );
    testState.members = [];
    testState.diskIdentities = [
      { workspaceId: FIRST_ID, workspacePath: first, name: 'First' },
      { workspaceId: SECOND_ID, workspacePath: second, name: 'Second' },
    ];
    testState.registryInitialized = false;
    process.env.HUABU_LEGACY_WORKSPACE_STORE = legacyFile;
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/workspaces' });

      expect(response.statusCode).toBe(200);
      expect(
        response.json().map((workspace: TestMember) => workspace.workspaceId),
      ).toEqual([SECOND_ID, FIRST_ID]);
      expect(
        locatorMocks.adoptWorkspaceDirectory.mock.calls.map(
          ([workspacePath]) => workspacePath,
        ),
      ).toEqual([first, second]);
      // Registration never prepares: the collection must not be held behind a
      // preparation fork per remembered folder, and a deleted folder must not
      // be recreated by remembering it.
      expect(activationMocks.prepareWorkspacePath).not.toHaveBeenCalled();
      expect(existsSync(deleted)).toBe(false);
      expect(testState.registryInitialized).toBe(true);
    } finally {
      await app.close();
      delete process.env.HUABU_LEGACY_WORKSPACE_STORE;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('attempts the deprecated desktop store once even when it registers nothing', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'huabu-route-legacy-once-'));
    const home = path.join(root, 'home');
    mkdirSync(home);
    const legacyFile = path.join(root, 'workspace.json');
    writeFileSync(legacyFile, JSON.stringify({ path: home }), 'utf8');
    testState.members = [];
    testState.registryInitialized = false;
    // Nothing gets registered, so `hasWorkspaceRegistry()` stays false and only
    // the once-only flag can stop the import repeating on every later request.
    const adoptImplementation =
      locatorMocks.adoptWorkspaceDirectory.getMockImplementation();
    locatorMocks.adoptWorkspaceDirectory.mockImplementation(() => {
      throw new Error('copied Workspace identity');
    });
    process.env.HUABU_LEGACY_WORKSPACE_STORE = legacyFile;
    const app = await buildApp();
    try {
      await app.inject({ method: 'GET', url: '/workspaces' });
      await app.inject({ method: 'GET', url: '/workspaces' });
      const last = await app.inject({ method: 'GET', url: '/workspaces' });

      expect(last.statusCode).toBe(200);
      expect(last.json()).toEqual([]);
      expect(locatorMocks.adoptWorkspaceDirectory).toHaveBeenCalledTimes(1);
      expect(testState.registryInitialized).toBe(false);
    } finally {
      await app.close();
      if (adoptImplementation) {
        locatorMocks.adoptWorkspaceDirectory.mockImplementation(
          adoptImplementation,
        );
      }
      delete process.env.HUABU_LEGACY_WORKSPACE_STORE;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never imports the deprecated desktop store in managed mode', async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), 'huabu-route-legacy-managed-'),
    );
    const home = path.join(root, 'home');
    mkdirSync(home);
    const legacyFile = path.join(root, 'workspace.json');
    writeFileSync(legacyFile, JSON.stringify({ path: home }), 'utf8');
    testState.managed = true;
    testState.registryInitialized = false;
    process.env.HUABU_LEGACY_WORKSPACE_STORE = legacyFile;
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/workspaces' });

      expect(response.statusCode).toBe(200);
      // Managed mode locks its Workspace at boot; a free-mode history file has
      // nothing to say about it.
      expect(locatorMocks.adoptWorkspaceDirectory).not.toHaveBeenCalled();
      expect(existsSync(path.join(home, '.workspace.json'))).toBe(false);
    } finally {
      await app.close();
      delete process.env.HUABU_LEGACY_WORKSPACE_STORE;
      rmSync(root, { recursive: true, force: true });
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

  it('follows an externally moved active Workspace without splitting its path', async () => {
    testState.diskIdentities = [
      {
        workspaceId: FIRST_ID,
        workspacePath: '/tmp/moved-first',
        name: 'First',
      },
      testState.diskIdentities[1] as TestMember,
    ];
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/workspaces',
        payload: { path: '/tmp/moved-first' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        workspaceId: FIRST_ID,
        name: 'First',
        path: '/tmp/moved-first',
        active: true,
      });
      expect(testState.activePath).toBe('/tmp/moved-first');
      expect(
        testState.members.filter((member) => member.workspaceId === FIRST_ID),
      ).toEqual([
        {
          workspaceId: FIRST_ID,
          workspacePath: '/tmp/moved-first',
          name: 'First',
        },
      ]);
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
      await expect(repository.get(SECOND_ID)).resolves.toBeNull();
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
