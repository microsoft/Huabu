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

import {
  DiskWorkspaceRepository,
  WORKSPACE_MANIFEST_DIR,
  WORKSPACE_MANIFEST_FILENAME,
  WORKSPACE_REGISTRY_FILENAME,
} from './workspace-repository.js';
import { getWorkspaceRepository } from '../../storage.js';

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
    // vitest.setup.ts points HUABU_DATA_DIR at a per-file temp directory.
    const dataDir = process.env.HUABU_DATA_DIR as string;
    const root = tempDir('huabu-workspace-store-root-');
    const workspace = getWorkspaceRepository().open(root);

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

  it('keeps the collection readable when one registered folder is gone', () => {
    const dataDir = tempDir('huabu-workspace-gone-data-');
    const kept = tempDir('huabu-workspace-gone-kept-');
    const gone = tempDir('huabu-workspace-gone-missing-');
    const filePath = registryPath(dataDir);
    const repository = new DiskWorkspaceRepository(filePath);
    const survivor = repository.open(kept);
    const missing = repository.open(gone);

    // An unplugged volume or a folder deleted in Finder looks exactly like
    // this, and it must not take down the whole listing.
    rmSync(gone, { recursive: true, force: true });

    const reopened = new DiskWorkspaceRepository(filePath);
    expect(reopened.list()).toEqual([survivor]);
    expect(reopened.get(missing.workspaceId)).toBeNull();
    expect(reopened.getByPath(gone)).toBeNull();
    // The registration survives, so the Workspace returns when its volume does.
    expect(
      (
        JSON.parse(readFileSync(filePath, 'utf8')) as {
          workspaces: unknown[];
        }
      ).workspaces,
    ).toHaveLength(2);
    // ... and it can still be unregistered while unreachable.
    expect(reopened.remove(missing.workspaceId)).toBe(true);
    expect(reopened.list()).toEqual([survivor]);
  });

  it('still reports a malformed manifest rather than hiding it as unreachable', () => {
    const filePath = registryPath(tempDir('huabu-workspace-damaged-data-'));
    const root = tempDir('huabu-workspace-damaged-');
    const repository = new DiskWorkspaceRepository(filePath);
    repository.open(root);
    writeFileSync(manifestPath(root), '{ definitely not json', 'utf8');

    expect(() => new DiskWorkspaceRepository(filePath).list()).toThrow(
      /workspace manifest/i,
    );
  });

  it('re-adopts a registered path whose folder was replaced', () => {
    const dataDir = tempDir('huabu-workspace-replaced-data-');
    const parent = tempDir('huabu-workspace-replaced-root-');
    const root = path.join(parent, 'home');
    mkdirSync(root);
    const filePath = registryPath(dataDir);
    const repository = new DiskWorkspaceRepository(filePath);
    const original = repository.open(root);

    // Deleted outside Huabu and recreated by hand: the folder at this path is
    // a different Workspace now, and pointing Huabu at it must keep working.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);

    const sameProcess = repository.open(root);
    expect(sameProcess.workspaceId).not.toBe(original.workspaceId);
    expect(sameProcess.workspacePath).toBe(path.resolve(root));
    expect(repository.get(original.workspaceId)).toBeNull();
    expect(repository.list()).toEqual([sameProcess]);

    // And the same holds for a Server that only sees it after a restart.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    const afterRestart = new DiskWorkspaceRepository(filePath);
    const readopted = afterRestart.open(root);
    expect(readopted.workspaceId).not.toBe(sameProcess.workspaceId);
    expect(afterRestart.list()).toEqual([readopted]);
  });

  it('frees a moved Workspace to keep its identity when its old path is reused', () => {
    const dataDir = tempDir('huabu-workspace-swap-data-');
    const parent = tempDir('huabu-workspace-swap-root-');
    const original = path.join(parent, 'original');
    const moved = path.join(parent, 'moved');
    mkdirSync(original);
    const filePath = registryPath(dataDir);
    const repository = new DiskWorkspaceRepository(filePath);
    const first = repository.open(original);

    renameSync(original, moved);
    mkdirSync(original);
    const replacement = repository.open(original);
    const relocated = repository.open(moved);

    expect(relocated.workspaceId).toBe(first.workspaceId);
    expect(relocated.workspacePath).toBe(path.resolve(moved));
    expect(repository.list()).toEqual([replacement, relocated]);
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
