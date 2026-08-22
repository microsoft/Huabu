// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DiskStructuredStore } from './structured-store.js';
import {
  DiskWorkspaceRepository,
  WORKSPACE_MANIFEST_DIR,
  WORKSPACE_MANIFEST_FILENAME,
  WORKSPACE_REGISTRY_FILENAME,
} from './workspace-repository.js';

describe('DiskWorkspaceRepository', () => {
  const roots: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
  }

  function manifestPath(root: string): string {
    return path.join(root, WORKSPACE_MANIFEST_DIR, WORKSPACE_MANIFEST_FILENAME);
  }

  function registryPath(dataDir: string): string {
    return path.join(dataDir, 'storage', 'disk', WORKSPACE_REGISTRY_FILENAME);
  }

  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adopts a legacy Workspace by creating a stable hidden manifest', () => {
    const root = tempDir('huabu-legacy-workspace-');
    const firstRepository = new DiskWorkspaceRepository();
    const first = firstRepository.open(root);

    expect(first.workspacePath).toBe(path.resolve(root));
    expect(first.name).toBe(path.basename(root));
    expect(first.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const persisted = JSON.parse(readFileSync(manifestPath(root), 'utf8')) as {
      schemaVersion: number;
      workspaceId: string;
      name: string;
    };
    expect(persisted).toEqual({
      schemaVersion: 1,
      workspaceId: first.workspaceId,
      name: path.basename(root),
    });

    const reopened = new DiskWorkspaceRepository().open(root);
    expect(reopened).toEqual(first);
  });

  it('indexes opened Workspaces by both stable id and canonical path', () => {
    const repository = new DiskWorkspaceRepository();
    const first = repository.open(tempDir('huabu-workspace-first-'));
    const second = repository.open(tempDir('huabu-workspace-second-'));

    expect(repository.get(first.workspaceId)).toEqual(first);
    expect(repository.getByPath(first.workspacePath)).toEqual(first);
    expect(repository.list()).toEqual([first, second]);
  });

  it('persists only the stable id-to-path index and rehydrates metadata after restart', () => {
    const dataDir = tempDir('huabu-workspace-data-');
    const root = tempDir('huabu-workspace-persisted-');
    const filePath = registryPath(dataDir);
    const repository = new DiskWorkspaceRepository(filePath);
    const workspace = repository.open(root);
    const renamed = repository.rename(workspace.workspaceId, 'Research');

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: workspace.workspaceId,
          workspacePath: path.resolve(root),
        },
      ],
    });
    expect(new DiskWorkspaceRepository(filePath).list()).toEqual([renamed]);
  });

  it('stores the production registry under the Disk backend data directory', () => {
    const dataDir = tempDir('huabu-workspace-store-data-');
    const root = tempDir('huabu-workspace-store-root-');
    const workspace = new DiskStructuredStore(dataDir).workspaces().open(root);

    expect(JSON.parse(readFileSync(registryPath(dataDir), 'utf8'))).toEqual({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: workspace.workspaceId,
          workspacePath: path.resolve(root),
        },
      ],
    });
  });

  it('recognizes an externally moved Workspace by id and replaces its registered path', () => {
    const dataDir = tempDir('huabu-workspace-move-data-');
    const parent = tempDir('huabu-workspace-move-root-');
    const originalPath = path.join(parent, 'original');
    const movedPath = path.join(parent, 'moved');
    mkdirSync(originalPath);
    const filePath = registryPath(dataDir);
    const original = new DiskWorkspaceRepository(filePath).open(originalPath);

    renameSync(originalPath, movedPath);
    const reopened = new DiskWorkspaceRepository(filePath);
    const moved = reopened.open(movedPath);

    expect(moved).toEqual({
      ...original,
      workspacePath: path.resolve(movedPath),
    });
    expect(reopened.getByPath(originalPath)).toBeNull();
    expect(reopened.get(original.workspaceId)).toEqual(moved);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: original.workspaceId,
          workspacePath: path.resolve(movedPath),
        },
      ],
    });
  });

  it('rejects two different paths that claim the same Workspace identity', () => {
    const firstRoot = tempDir('huabu-workspace-original-');
    const secondRoot = tempDir('huabu-workspace-copy-');
    const filePath = registryPath(tempDir('huabu-workspace-copy-data-'));
    const repository = new DiskWorkspaceRepository(filePath);
    const first = repository.open(firstRoot);

    mkdirSync(path.dirname(manifestPath(secondRoot)), { recursive: true });
    writeFileSync(
      manifestPath(secondRoot),
      JSON.stringify({
        schemaVersion: 1,
        workspaceId: first.workspaceId,
        name: 'Copied Workspace',
      }),
      'utf8',
    );

    expect(() =>
      new DiskWorkspaceRepository(filePath).open(secondRoot),
    ).toThrow(/present at both.*copied Workspaces/i);
  });

  it('rejects a malformed existing manifest instead of replacing it', () => {
    const root = tempDir('huabu-workspace-corrupt-');
    mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    writeFileSync(manifestPath(root), '{ definitely not json', 'utf8');

    expect(() => new DiskWorkspaceRepository().open(root)).toThrow(
      /workspace manifest/i,
    );
    expect(readFileSync(manifestPath(root), 'utf8')).toBe(
      '{ definitely not json',
    );
  });

  it('renames a Workspace durably and updates both indexes', () => {
    const root = tempDir('huabu-workspace-rename-');
    const repository = new DiskWorkspaceRepository();
    const original = repository.open(root);

    const renamed = repository.rename(original.workspaceId, 'Research');

    expect(renamed).toEqual({ ...original, name: 'Research' });
    expect(repository.get(original.workspaceId)).toEqual(renamed);
    expect(repository.getByPath(root)).toEqual(renamed);
    expect(new DiskWorkspaceRepository().open(root)).toEqual(renamed);
  });

  it('unregisters a Workspace without deleting its manifest', () => {
    const root = tempDir('huabu-workspace-remove-');
    const filePath = registryPath(tempDir('huabu-workspace-remove-data-'));
    const repository = new DiskWorkspaceRepository(filePath);
    const workspace = repository.open(root);

    expect(repository.remove(workspace.workspaceId)).toBe(true);
    expect(repository.get(workspace.workspaceId)).toBeNull();
    expect(repository.getByPath(root)).toBeNull();
    expect(readFileSync(manifestPath(root), 'utf8')).toContain(
      workspace.workspaceId,
    );
    expect(new DiskWorkspaceRepository(filePath).list()).toEqual([]);
  });

  it('rejects a malformed durable registry instead of discarding it', () => {
    const filePath = registryPath(tempDir('huabu-workspace-corrupt-data-'));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        workspaces: [{ workspacePath: '/missing-id', name: 'Not indexed' }],
      }),
      'utf8',
    );

    expect(() => new DiskWorkspaceRepository(filePath).list()).toThrow(
      /workspace registry.*invalid/i,
    );
  });
});
