// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DiskWorkspaceRepository,
  WORKSPACE_MANIFEST_DIR,
  WORKSPACE_MANIFEST_FILENAME,
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

  it('rejects two different paths that claim the same Workspace identity', () => {
    const firstRoot = tempDir('huabu-workspace-original-');
    const secondRoot = tempDir('huabu-workspace-copy-');
    const repository = new DiskWorkspaceRepository();
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

    expect(() => repository.open(secondRoot)).toThrow(
      /same Workspace identity.*different paths/i,
    );
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
});
