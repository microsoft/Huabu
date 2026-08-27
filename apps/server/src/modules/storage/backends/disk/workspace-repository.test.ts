// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
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

import {
  DiskWorkspaceRepository,
  WORKSPACE_MANIFEST_FILENAME,
  WORKSPACE_REGISTRY_FILENAME,
} from './workspace-repository.js';
import { describeWorkspaceRepositoryContract } from '../../ports/contracts/workspace-repository.contract.js';
import { adoptWorkspaceDirectory } from '../../storage.js';

describe('DiskWorkspaceRepository', () => {
  const roots: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
  }

  function manifestPath(root: string): string {
    return path.join(root, WORKSPACE_MANIFEST_FILENAME);
  }

  function registryPath(dataDir: string): string {
    return path.join(dataDir, 'storage', 'disk', WORKSPACE_REGISTRY_FILENAME);
  }

  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  afterEach(() => vi.restoreAllMocks());

  describeWorkspaceRepositoryContract('Disk', async () => {
    const repository = new DiskWorkspaceRepository();
    return {
      repository,
      create: async (name: string) => {
        const workspace = repository.adopt(
          tempDir('huabu-workspace-contract-'),
        );
        const renamed = await repository.rename(workspace.workspaceId, name);
        if (!renamed) throw new Error('Expected adopted Workspace to rename');
        return renamed;
      },
    };
  });

  it('adopts a legacy Workspace by creating a stable manifest', () => {
    const root = tempDir('huabu-legacy-workspace-');
    const firstRepository = new DiskWorkspaceRepository();
    const first = firstRepository.adopt(root);

    expect(firstRepository.directoryOf(first.workspaceId)).toBe(
      path.resolve(root),
    );
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

    const reopened = new DiskWorkspaceRepository().adopt(root);
    expect(reopened).toEqual(first);
  });

  it('indexes adopted Workspaces by both stable id and canonical path', async () => {
    const repository = new DiskWorkspaceRepository();
    const firstRoot = tempDir('huabu-workspace-first-');
    const first = repository.adopt(firstRoot);
    const second = repository.adopt(tempDir('huabu-workspace-second-'));

    await expect(repository.get(first.workspaceId)).resolves.toEqual(first);
    expect(repository.at(firstRoot)).toEqual(first);
    expect(repository.directoryOf(first.workspaceId)).toBe(
      path.resolve(firstRoot),
    );
    await expect(repository.list()).resolves.toEqual([second, first]);
  });

  it('persists recency as timestamps instead of array order', async () => {
    const firstOpenedAt = Date.parse('2026-08-26T01:00:00.000Z');
    const secondOpenedAt = Date.parse('2026-08-26T02:00:00.000Z');
    const reopenedAt = Date.parse('2026-08-26T03:00:00.000Z');
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(firstOpenedAt)
      .mockReturnValueOnce(secondOpenedAt)
      .mockReturnValue(reopenedAt);
    const filePath = registryPath(tempDir('huabu-workspace-timestamp-data-'));
    const repository = new DiskWorkspaceRepository(filePath);
    const firstRoot = tempDir('huabu-workspace-timestamp-first-');
    const secondRoot = tempDir('huabu-workspace-timestamp-second-');

    const first = repository.adopt(firstRoot);
    const second = repository.adopt(secondRoot);

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: first.workspaceId,
          workspacePath: path.resolve(firstRoot),
          lastOpenedAt: new Date(firstOpenedAt).toISOString(),
        },
        {
          workspaceId: second.workspaceId,
          workspacePath: path.resolve(secondRoot),
          lastOpenedAt: new Date(secondOpenedAt).toISOString(),
        },
      ],
    });
    await expect(repository.list()).resolves.toEqual([second, first]);

    repository.adopt(firstRoot);

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: first.workspaceId,
          workspacePath: path.resolve(firstRoot),
          lastOpenedAt: new Date(reopenedAt).toISOString(),
        },
        {
          workspaceId: second.workspaceId,
          workspacePath: path.resolve(secondRoot),
          lastOpenedAt: new Date(secondOpenedAt).toISOString(),
        },
      ],
    });
    await expect(new DiskWorkspaceRepository(filePath).list()).resolves.toEqual(
      [first, second],
    );
  });

  it('persists the locator and recency timestamp and rehydrates metadata after restart', async () => {
    const dataDir = tempDir('huabu-workspace-data-');
    const root = tempDir('huabu-workspace-persisted-');
    const filePath = registryPath(dataDir);
    const repository = new DiskWorkspaceRepository(filePath);
    const workspace = repository.adopt(root);
    const renamed = await repository.rename(workspace.workspaceId, 'Research');

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: workspace.workspaceId,
          workspacePath: path.resolve(root),
          lastOpenedAt: expect.any(String),
        },
      ],
    });
    await expect(new DiskWorkspaceRepository(filePath).list()).resolves.toEqual(
      [renamed],
    );
  });

  it('stores the production registry under the Disk backend data directory', () => {
    // vitest.setup.ts points HUABU_DATA_DIR at a per-file temp directory.
    const dataDir = process.env.HUABU_DATA_DIR as string;
    const root = tempDir('huabu-workspace-store-root-');
    const workspace = adoptWorkspaceDirectory(root);

    expect(JSON.parse(readFileSync(registryPath(dataDir), 'utf8'))).toEqual({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: workspace.workspaceId,
          workspacePath: path.resolve(root),
          lastOpenedAt: expect.any(String),
        },
      ],
    });
  });

  it('recognizes an externally moved Workspace by id and replaces its registered path', async () => {
    const dataDir = tempDir('huabu-workspace-move-data-');
    const parent = tempDir('huabu-workspace-move-root-');
    const originalPath = path.join(parent, 'original');
    const movedPath = path.join(parent, 'moved');
    mkdirSync(originalPath);
    const filePath = registryPath(dataDir);
    const original = new DiskWorkspaceRepository(filePath).adopt(originalPath);

    renameSync(originalPath, movedPath);
    const reopened = new DiskWorkspaceRepository(filePath);
    const moved = reopened.adopt(movedPath);

    expect(moved).toEqual(original);
    expect(reopened.directoryOf(moved.workspaceId)).toBe(
      path.resolve(movedPath),
    );
    expect(reopened.at(originalPath)).toBeNull();
    await expect(reopened.get(original.workspaceId)).resolves.toEqual(moved);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      workspaces: [
        {
          workspaceId: original.workspaceId,
          workspacePath: path.resolve(movedPath),
          lastOpenedAt: expect.any(String),
        },
      ],
    });
  });

  it('treats a symlink alias as the same Workspace directory, not a copy', async () => {
    const root = tempDir('huabu-workspace-symlink-target-');
    const aliasParent = tempDir('huabu-workspace-symlink-parent-');
    const alias = path.join(aliasParent, 'alias');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const repository = new DiskWorkspaceRepository(
      registryPath(tempDir('huabu-workspace-symlink-data-')),
    );
    const throughAlias = repository.adopt(alias);

    expect(() => repository.adopt(root)).not.toThrow();
    await expect(repository.get(throughAlias.workspaceId)).resolves.toEqual(
      throughAlias,
    );
    expect(repository.directoryOf(throughAlias.workspaceId)).toBe(
      path.resolve(root),
    );
  });

  it('rejects two different paths that claim the same Workspace identity', () => {
    const firstRoot = tempDir('huabu-workspace-original-');
    const secondRoot = tempDir('huabu-workspace-copy-');
    const filePath = registryPath(tempDir('huabu-workspace-copy-data-'));
    const repository = new DiskWorkspaceRepository(filePath);
    const first = repository.adopt(firstRoot);

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
      new DiskWorkspaceRepository(filePath).adopt(secondRoot),
    ).toThrow(/present at both.*copied Workspaces/i);
  });

  it('rejects a malformed existing manifest instead of replacing it', () => {
    const root = tempDir('huabu-workspace-corrupt-');
    mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    writeFileSync(manifestPath(root), '{ definitely not json', 'utf8');

    expect(() => new DiskWorkspaceRepository().adopt(root)).toThrow(
      /workspace manifest/i,
    );
    expect(readFileSync(manifestPath(root), 'utf8')).toBe(
      '{ definitely not json',
    );
  });

  it('renames a Workspace durably and updates both indexes', async () => {
    const root = tempDir('huabu-workspace-rename-');
    const repository = new DiskWorkspaceRepository();
    const original = repository.adopt(root);

    const renamed = await repository.rename(original.workspaceId, 'Research');

    expect(renamed).toEqual({ ...original, name: 'Research' });
    await expect(repository.get(original.workspaceId)).resolves.toEqual(
      renamed,
    );
    expect(repository.at(root)).toEqual(renamed);
    expect(new DiskWorkspaceRepository().adopt(root)).toEqual(renamed);
  });

  it('refuses a name the manifest schema would reject, leaving it unchanged', async () => {
    const root = tempDir('huabu-workspace-blank-name-');
    const repository = new DiskWorkspaceRepository();
    const original = repository.adopt(root);

    // The schema is the only definition of a valid name, and it guards the
    // write as well as the read — so an unusable one cannot be persisted and
    // then blow up as a "malformed manifest" on some later read.
    await expect(
      repository.rename(original.workspaceId, '   '),
    ).rejects.toThrow(/workspace manifest.*invalid/i);
    await expect(repository.get(original.workspaceId)).resolves.toEqual(
      original,
    );

    // A name that only needs trimming is accepted, normalized once, by the
    // same rule.
    await expect(
      repository.rename(original.workspaceId, '  Research  '),
    ).resolves.toEqual({ ...original, name: 'Research' });
  });

  it('unregisters a Workspace without deleting its manifest', async () => {
    const root = tempDir('huabu-workspace-remove-');
    const filePath = registryPath(tempDir('huabu-workspace-remove-data-'));
    const repository = new DiskWorkspaceRepository(filePath);
    const workspace = repository.adopt(root);

    await expect(repository.remove(workspace.workspaceId)).resolves.toBe(true);
    await expect(repository.get(workspace.workspaceId)).resolves.toBeNull();
    expect(repository.at(root)).toBeNull();
    expect(readFileSync(manifestPath(root), 'utf8')).toContain(
      workspace.workspaceId,
    );
    await expect(new DiskWorkspaceRepository(filePath).list()).resolves.toEqual(
      [],
    );
  });

  it('keeps the collection readable when one registered folder is gone', async () => {
    const dataDir = tempDir('huabu-workspace-gone-data-');
    const kept = tempDir('huabu-workspace-gone-kept-');
    const gone = tempDir('huabu-workspace-gone-missing-');
    const filePath = registryPath(dataDir);
    const repository = new DiskWorkspaceRepository(filePath);
    const survivor = repository.adopt(kept);
    const missing = repository.adopt(gone);

    // An unplugged volume or a folder deleted in Finder looks exactly like
    // this, and it must not take down the whole listing.
    rmSync(gone, { recursive: true, force: true });

    const reopened = new DiskWorkspaceRepository(filePath);
    await expect(reopened.list()).resolves.toEqual([survivor]);
    await expect(reopened.get(missing.workspaceId)).resolves.toBeNull();
    expect(reopened.at(gone)).toBeNull();
    // The registration survives, so the Workspace returns when its volume does.
    expect(
      (
        JSON.parse(readFileSync(filePath, 'utf8')) as {
          workspaces: unknown[];
        }
      ).workspaces,
    ).toHaveLength(2);
    // ... and it can still be unregistered while unreachable.
    await expect(reopened.remove(missing.workspaceId)).resolves.toBe(true);
    await expect(reopened.list()).resolves.toEqual([survivor]);
  });

  it('still reports a malformed manifest rather than hiding it as unreachable', async () => {
    const filePath = registryPath(tempDir('huabu-workspace-damaged-data-'));
    const root = tempDir('huabu-workspace-damaged-');
    const repository = new DiskWorkspaceRepository(filePath);
    repository.adopt(root);
    writeFileSync(manifestPath(root), '{ definitely not json', 'utf8');

    await expect(new DiskWorkspaceRepository(filePath).list()).rejects.toThrow(
      /workspace manifest/i,
    );
  });

  it('re-adopts a registered path whose folder was replaced', async () => {
    const dataDir = tempDir('huabu-workspace-replaced-data-');
    const parent = tempDir('huabu-workspace-replaced-root-');
    const root = path.join(parent, 'home');
    mkdirSync(root);
    const filePath = registryPath(dataDir);
    const repository = new DiskWorkspaceRepository(filePath);
    const original = repository.adopt(root);

    // Deleted outside Huabu and recreated by hand: the folder at this path is
    // a different Workspace now, and pointing Huabu at it must keep working.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);

    const sameProcess = repository.adopt(root);
    expect(sameProcess.workspaceId).not.toBe(original.workspaceId);
    expect(repository.directoryOf(sameProcess.workspaceId)).toBe(
      path.resolve(root),
    );
    await expect(repository.get(original.workspaceId)).resolves.toBeNull();
    await expect(repository.list()).resolves.toEqual([sameProcess]);

    // And the same holds for a Server that only sees it after a restart.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    const afterRestart = new DiskWorkspaceRepository(filePath);
    const readopted = afterRestart.adopt(root);
    expect(readopted.workspaceId).not.toBe(sameProcess.workspaceId);
    await expect(afterRestart.list()).resolves.toEqual([readopted]);
  });

  it('frees a moved Workspace to keep its identity when its old path is reused', async () => {
    const dataDir = tempDir('huabu-workspace-swap-data-');
    const parent = tempDir('huabu-workspace-swap-root-');
    const original = path.join(parent, 'original');
    const moved = path.join(parent, 'moved');
    mkdirSync(original);
    const filePath = registryPath(dataDir);
    const repository = new DiskWorkspaceRepository(filePath);
    const first = repository.adopt(original);

    renameSync(original, moved);
    mkdirSync(original);
    const replacement = repository.adopt(original);
    const relocated = repository.adopt(moved);

    expect(relocated.workspaceId).toBe(first.workspaceId);
    expect(repository.directoryOf(relocated.workspaceId)).toBe(
      path.resolve(moved),
    );
    await expect(repository.list()).resolves.toEqual([relocated, replacement]);
  });

  it('rejects a malformed durable registry instead of discarding it', async () => {
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

    await expect(new DiskWorkspaceRepository(filePath).list()).rejects.toThrow(
      /workspace registry.*invalid/i,
    );
  });
});
