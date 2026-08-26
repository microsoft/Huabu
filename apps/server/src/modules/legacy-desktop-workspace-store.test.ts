// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { migrateLegacyDesktopWorkspaceStore } from './legacy-desktop-workspace-store.js';
import {
  DiskWorkspaceRepository,
  WORKSPACE_MANIFEST_FILENAME,
} from './storage/backends/disk/workspace-repository.js';

describe('deprecated desktop Workspace store migration', () => {
  const roots: string[] = [];

  function tempDir(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('imports the legacy active path and recents in MRU order', async () => {
    const dataDir = tempDir('huabu-legacy-store-data-');
    const first = tempDir('huabu-legacy-store-first-');
    const second = tempDir('huabu-legacy-store-second-');
    const legacyFile = path.join(dataDir, 'workspace.json');
    const registryFile = path.join(
      dataDir,
      'data',
      'storage',
      'disk',
      'workspaces.json',
    );
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: second, recent: [second, first] }),
      'utf8',
    );
    const repository = new DiskWorkspaceRepository(registryFile);
    const prepareWorkspacePath = vi.fn(async (workspacePath: string) =>
      path.resolve(workspacePath),
    );

    await migrateLegacyDesktopWorkspaceStore(legacyFile, {
      hasWorkspaceRegistry: () => repository.hasDurableRegistry(),
      prepareWorkspacePath,
      adoptWorkspaceDirectory: (workspacePath) =>
        repository.adopt(workspacePath),
    });

    expect(
      prepareWorkspacePath.mock.calls.map(([workspacePath]) => workspacePath),
    ).toEqual([first, second]);
    const listed = await repository.list();
    expect(
      listed.map((workspace) => repository.directoryOf(workspace.workspaceId)),
    ).toEqual([path.resolve(second), path.resolve(first)]);
    expect(
      readFileSync(path.join(first, WORKSPACE_MANIFEST_FILENAME), 'utf8'),
    ).toContain('workspaceId');
  });

  it('ignores the deprecated file once workspaces.json exists', async () => {
    const dataDir = tempDir('huabu-legacy-store-existing-data-');
    const existing = tempDir('huabu-legacy-store-existing-');
    const legacy = tempDir('huabu-legacy-store-ignored-');
    const legacyFile = path.join(dataDir, 'workspace.json');
    const registryFile = path.join(dataDir, 'workspaces.json');
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: legacy, recent: [legacy] }),
      'utf8',
    );
    const repository = new DiskWorkspaceRepository(registryFile);
    const registered = repository.adopt(existing);
    const prepareWorkspacePath = vi.fn(
      async (workspacePath: string) => workspacePath,
    );

    await expect(
      migrateLegacyDesktopWorkspaceStore(legacyFile, {
        hasWorkspaceRegistry: () => repository.hasDurableRegistry(),
        prepareWorkspacePath,
        adoptWorkspaceDirectory: (workspacePath) =>
          repository.adopt(workspacePath),
      }),
    ).resolves.toBeUndefined();

    expect(prepareWorkspacePath).not.toHaveBeenCalled();
    await expect(repository.list()).resolves.toEqual([registered]);
  });

  it('leaves the registry absent when no legacy entry can be migrated', async () => {
    const dataDir = tempDir('huabu-legacy-store-empty-data-');
    const legacyFile = path.join(dataDir, 'workspace.json');
    writeFileSync(
      legacyFile,
      JSON.stringify({ path: '/unavailable', recent: ['/unavailable'] }),
      'utf8',
    );
    const repository = new DiskWorkspaceRepository(
      path.join(dataDir, 'storage', 'disk', 'workspaces.json'),
    );

    await migrateLegacyDesktopWorkspaceStore(legacyFile, {
      hasWorkspaceRegistry: () => repository.hasDurableRegistry(),
      prepareWorkspacePath: async () => {
        throw new Error('unavailable');
      },
      adoptWorkspaceDirectory: (workspacePath) =>
        repository.adopt(workspacePath),
    });

    expect(repository.hasDurableRegistry()).toBe(false);
    await expect(repository.list()).resolves.toEqual([]);
  });
});
