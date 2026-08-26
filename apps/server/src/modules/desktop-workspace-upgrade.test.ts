// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * End-to-end upgrade of a desktop install that predates the plural Workspace
 * registry, over the production routes and against real storage.
 *
 * Nothing here is mocked. The Disk Workspace repository, the durable registry
 * under `HUABU_DATA_DIR`, the Workspace manifests, and both Workspace route
 * plugins are the real ones, mounted at the same prefixes `app.ts` uses. The
 * only thing this suite substitutes for is the process boundary around
 * activation: `defaultWorkerPath()` resolves to the TypeScript worker when the
 * Server is not bundled, and Vitest does not propagate a TS loader to a
 * `fork()`ed child. Activation therefore runs through `setWorkspacePath()`,
 * which `workspace-prepare.ts` documents as the in-process entry point for
 * startup and tests and which performs exactly the same on-disk work. The
 * isolation itself is covered by `workspace-activation.test.ts`.
 *
 * The story under test is the one an upgrading user actually walks through:
 * an Electron `<userData>/workspace.json` naming Home folders they used
 * before, some of which no longer exist, then a first launch that must
 * recover their history without touching folders they did not open.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { workspaceRegistryPath } from './storage/backends/disk/workspace-repository.js';
import { resetStorageCache } from './storage/index.js';
import { setWorkspacePath } from './workspace.js';
import workspaceRoutes from './workspace.route.js';
import workspacesRoutes from './workspaces.route.js';

import type { WorkspaceDescriptor, WorkspaceInfo } from '@huabu/shared';
import type { FastifyInstance } from 'fastify';

const WORLD_DIR = '.world';
const MANIFEST = '.workspace.json';

describe('desktop upgrade to the plural Workspace registry', () => {
  const roots: string[] = [];
  let userData: string;
  let legacyFile: string;

  function tempDir(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  /** Mount the Workspace plugins at the prefixes `app.ts` uses. */
  async function buildApp(): Promise<FastifyInstance> {
    const app = fastify();
    await app.register(workspaceRoutes, { prefix: '/api/workspace' });
    await app.register(workspacesRoutes, { prefix: '/api/workspaces' });
    await app.ready();
    return app;
  }

  /** A Home folder as an older Huabu left it: content, but no manifest. */
  function seedLegacyHome(prefix: string, spaceTitle: string): string {
    const home = tempDir(prefix);
    const space = path.join(home, spaceTitle);
    mkdirSync(space, { recursive: true });
    // `canvas.json` is the pre-rename name `migrateCanvasToSpace` converts.
    writeFileSync(
      path.join(space, 'canvas.json'),
      JSON.stringify({ canvasId: `canvas-${spaceTitle}`, title: spaceTitle }),
      'utf8',
    );
    return home;
  }

  function registryFile(): string {
    return workspaceRegistryPath(process.env.HUABU_DATA_DIR as string);
  }

  function readRegistry(): {
    schemaVersion: number;
    workspaces: { workspacePath: string; lastOpenedAt: string }[];
  } {
    return JSON.parse(readFileSync(registryFile(), 'utf8')) as ReturnType<
      typeof readRegistry
    >;
  }

  async function listWorkspaces(
    app: FastifyInstance,
  ): Promise<WorkspaceDescriptor[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspaces',
    });
    expect(response.statusCode).toBe(200);
    return response.json() as WorkspaceDescriptor[];
  }

  beforeEach(() => {
    userData = tempDir('huabu-upgrade-userdata-');
    legacyFile = path.join(userData, 'workspace.json');
    process.env.HUABU_LEGACY_WORKSPACE_STORE = legacyFile;
    // A fresh install of the new build: the durable registry does not exist
    // yet. The repository re-reads the file on every access, so removing it is
    // a complete reset even though the instance is process-wide.
    rmSync(registryFile(), { force: true });
    resetStorageCache();
  });

  afterEach(() => {
    delete process.env.HUABU_LEGACY_WORKSPACE_STORE;
    rmSync(registryFile(), { force: true });
    resetStorageCache();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers the remembered Home folders on the first launch', async () => {
    const older = seedLegacyHome('huabu-upgrade-older-', 'Older Space');
    const active = seedLegacyHome('huabu-upgrade-active-', 'Active Space');
    const deleted = path.join(userData, 'home-the-user-deleted');
    writeFileSync(
      legacyFile,
      JSON.stringify({
        path: active,
        recent: [active, older, deleted],
      }),
      'utf8',
    );

    const app = await buildApp();
    try {
      const listed = await listWorkspaces(app);

      // Most recently used first, with the entry whose folder is gone dropped.
      expect(listed.map((workspace) => workspace.path)).toEqual([
        path.resolve(active),
        path.resolve(older),
      ]);
      expect(listed.every((workspace) => workspace.active === false)).toBe(
        true,
      );

      // The registry now exists and carries recency as data, not array order.
      const registry = readRegistry();
      expect(registry.schemaVersion).toBe(1);
      expect(registry.workspaces.map((entry) => entry.workspacePath)).toEqual([
        path.resolve(older),
        path.resolve(active),
      ]);
      const stamps = registry.workspaces.map((entry) =>
        Date.parse(entry.lastOpenedAt),
      );
      expect(stamps[1]).toBeGreaterThan(stamps[0] ?? Number.NaN);

      // Recovering history is not opening a folder: the deleted Home folder
      // stays deleted, and neither survivor is prepared or migrated.
      expect(existsSync(deleted)).toBe(false);
      // Adoption adds the identity manifest and nothing else. Preparation
      // would have added the world canvas and rewritten the legacy Space.
      expect(readdirSync(active).sort()).toEqual(
        [MANIFEST, 'Active Space'].sort(),
      );
      expect(readdirSync(older).sort()).toEqual(
        [MANIFEST, 'Older Space'].sort(),
      );
      expect(existsSync(path.join(active, 'Active Space', 'canvas.json'))).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it('prepares only the Workspace the user actually opens', async () => {
    const older = seedLegacyHome('huabu-upgrade-older-', 'Older Space');
    const active = seedLegacyHome('huabu-upgrade-active-', 'Active Space');
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: active, recent: [active, older] }),
      'utf8',
    );

    const app = await buildApp();
    try {
      const listed = await listWorkspaces(app);
      const target = listed[0];
      expect(target?.path).toBe(path.resolve(active));

      // What the web client does next with the restored MRU entry.
      setWorkspacePath(target?.path as string);

      // The opened Workspace is migrated: legacy `canvas.json` became
      // `space.json` and the world canvas exists.
      expect(existsSync(path.join(active, WORLD_DIR))).toBe(true);
      expect(existsSync(path.join(active, 'Active Space', 'space.json'))).toBe(
        true,
      );
      // The one the user did not open is still exactly as it was found.
      expect(existsSync(path.join(older, WORLD_DIR))).toBe(false);
      expect(existsSync(path.join(older, 'Older Space', 'canvas.json'))).toBe(
        true,
      );

      const afterActivation = await listWorkspaces(app);
      expect(afterActivation[0]?.path).toBe(path.resolve(active));
      expect(afterActivation[0]?.active).toBe(true);

      const info = await app.inject({ method: 'GET', url: '/api/workspace' });
      expect(info.statusCode).toBe(200);
      expect(info.json() as WorkspaceInfo).toMatchObject({
        mode: 'free',
        configured: true,
        path: path.resolve(active),
      });
    } finally {
      await app.close();
    }
  });

  it('never consults the deprecated file again once the registry exists', async () => {
    const first = seedLegacyHome('huabu-upgrade-first-', 'First Space');
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: first, recent: [first] }),
      'utf8',
    );

    const firstLaunch = await buildApp();
    try {
      expect(await listWorkspaces(firstLaunch)).toHaveLength(1);
    } finally {
      await firstLaunch.close();
    }

    // The user removes the Home folder through the app, then relaunches. A
    // second import would silently resurrect the registration they just
    // dropped, so the registry's existence has to win over the legacy file.
    const relaunch = await buildApp();
    try {
      const listed = await listWorkspaces(relaunch);
      const removal = await relaunch.inject({
        method: 'DELETE',
        url: `/api/workspaces/${listed[0]?.workspaceId ?? ''}`,
      });
      expect(removal.statusCode).toBe(204);
      expect(await listWorkspaces(relaunch)).toEqual([]);
    } finally {
      await relaunch.close();
    }

    const afterRemoval = await buildApp();
    try {
      expect(await listWorkspaces(afterRemoval)).toEqual([]);
      // Unregistering never deletes the Workspace itself.
      expect(existsSync(path.join(first, MANIFEST))).toBe(true);
    } finally {
      await afterRemoval.close();
    }
  });

  it('restores the folder in use, not a copy of it left in the recents', async () => {
    const active = seedLegacyHome('huabu-upgrade-real-', 'Space');
    // Give it an identity, then duplicate the folder — a user keeping a
    // backup copy of their Home folder, with both in the recents list.
    writeFileSync(
      path.join(active, MANIFEST),
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: '11111111-1111-4111-8111-111111111111',
        name: 'Real',
      }),
      'utf8',
    );
    const backup = path.join(tempDir('huabu-upgrade-backup-'), 'backup');
    cpSync(active, backup, { recursive: true });
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: active, recent: [active, backup] }),
      'utf8',
    );

    const app = await buildApp();
    try {
      // Only one of the two can hold the identity. Restoring the user into a
      // stale copy of their own Workspace would be the worst outcome here, so
      // the recent path has to win over the older duplicate.
      const listed = await listWorkspaces(app);
      expect(listed.map((workspace) => workspace.path)).toEqual([
        path.resolve(active),
      ]);
    } finally {
      await app.close();
    }
  });

  it('treats a symlink alias and its target as one Workspace', async () => {
    const real = seedLegacyHome('huabu-upgrade-target-', 'Space');
    const link = path.join(tempDir('huabu-upgrade-alias-'), 'link');
    symlinkSync(real, link, 'dir');
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: link, recent: [link, real] }),
      'utf8',
    );

    const app = await buildApp();
    try {
      const listed = await listWorkspaces(app);
      expect(listed.map((workspace) => workspace.path)).toEqual([
        path.resolve(link),
      ]);
    } finally {
      await app.close();
    }
  });

  it('imports once when the first requests arrive together', async () => {
    const one = seedLegacyHome('huabu-upgrade-one-', 'One');
    const two = seedLegacyHome('huabu-upgrade-two-', 'Two');
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: one, recent: [one, two] }),
      'utf8',
    );

    const app = await buildApp();
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          app.inject({ method: 'GET', url: '/api/workspaces' }),
        ),
      );

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json() as WorkspaceDescriptor[]).toHaveLength(2);
      }
      expect(readRegistry().workspaces).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('serves the collection normally when there is nothing to upgrade', async () => {
    const app = await buildApp();
    try {
      // No `<userData>/workspace.json` at all — a fresh install, not an
      // upgrade. The import must be a silent no-op, not an error.
      expect(existsSync(legacyFile)).toBe(false);

      expect(await listWorkspaces(app)).toEqual([]);
      expect(existsSync(registryFile())).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('refuses to unregister the Workspace that is currently active', async () => {
    const home = seedLegacyHome('huabu-upgrade-active-only-', 'Only Space');
    writeFileSync(legacyFile, JSON.stringify({ path: home }), 'utf8');

    const app = await buildApp();
    try {
      const listed = await listWorkspaces(app);
      setWorkspacePath(listed[0]?.path as string);

      const removal = await app.inject({
        method: 'DELETE',
        url: `/api/workspaces/${listed[0]?.workspaceId ?? ''}`,
      });

      expect(removal.statusCode).toBe(409);
      expect(await listWorkspaces(app)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
