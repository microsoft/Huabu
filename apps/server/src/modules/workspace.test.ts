// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { workspaceAtDirectory } from './storage/index.js';
import { prepareWorkspaceOnDisk } from './workspace-prepare.js';
import {
  acquireWorkspaceOperationLease,
  commitWorkspacePath,
  getWorkspaceHandle,
  getWorkspacePath,
  setWorkspacePath,
  WorkspaceOperationInProgressError,
} from './workspace.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('workspace operation leases', () => {
  it('blocks a commit to another workspace until every lease is released', () => {
    const current = tempDir('huabu-workspace-current-');
    const next = tempDir('huabu-workspace-next-');
    expect(() => setWorkspacePath(current)).not.toThrow();

    const first = acquireWorkspaceOperationLease();
    const second = acquireWorkspaceOperationLease();
    expect(first.workspacePath).toBe(path.resolve(current));
    expect(second.workspacePath).toBe(path.resolve(current));

    expect(() => commitWorkspacePath(path.resolve(next))).toThrow(
      WorkspaceOperationInProgressError,
    );
    expect(getWorkspacePath()).toBe(path.resolve(current));

    first.release();
    first.release();
    expect(() => commitWorkspacePath(path.resolve(next))).toThrow(
      WorkspaceOperationInProgressError,
    );

    second.release();
    expect(() => commitWorkspacePath(path.resolve(next))).not.toThrow();
    expect(getWorkspacePath()).toBe(path.resolve(next));
  });

  it('allows same-path activation but rejects setWorkspacePath before preparing another path', () => {
    const current = tempDir('huabu-workspace-current-');
    const parent = tempDir('huabu-workspace-parent-');
    const next = path.join(parent, 'not-created');
    setWorkspacePath(current);

    const lease = acquireWorkspaceOperationLease();
    expect(() => setWorkspacePath(path.join(current, '.'))).not.toThrow();
    expect(getWorkspacePath()).toBe(path.resolve(current));

    expect(() => setWorkspacePath(next)).toThrow(
      WorkspaceOperationInProgressError,
    );
    expect(existsSync(next)).toBe(false);
    expect(getWorkspacePath()).toBe(path.resolve(current));

    lease.release();
    expect(() => setWorkspacePath(next)).not.toThrow();
    expect(existsSync(next)).toBe(true);
    expect(getWorkspacePath()).toBe(path.resolve(next));
  });

  it('leaves a refused workspace untouched on disk and in the registry', () => {
    const current = tempDir('huabu-workspace-held-');
    const refused = tempDir('huabu-workspace-refused-');
    setWorkspacePath(current);
    const lease = acquireWorkspaceOperationLease();

    try {
      // The guard has to run before any adoption: a switch this process
      // refuses must not leave the target carrying a manifest or a
      // registration it never asked for.
      expect(() => commitWorkspacePath(refused)).toThrow(
        WorkspaceOperationInProgressError,
      );
      expect(existsSync(path.join(refused, '.workspace.json'))).toBe(false);
      expect(workspaceAtDirectory(refused)).toBeNull();
      const registry = path.join(
        process.env.HUABU_DATA_DIR as string,
        'storage',
        'disk',
        'workspaces.json',
      );
      expect(readFileSync(registry, 'utf8')).not.toContain(refused);
    } finally {
      lease.release();
    }
  });

  it('separates the portable Workspace identity from its materialized path', () => {
    const current = tempDir('huabu-workspace-handle-');
    setWorkspacePath(current);

    // The handle is what a non-directory backend could also produce; where
    // the Workspace lives is a Disk materialization fact resolved separately.
    const handle = getWorkspaceHandle();
    expect(handle).toEqual({
      workspaceId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      name: path.basename(current),
    });
    expect(getWorkspacePath()).toBe(path.resolve(current));
  });
});

describe('workspace preparation', () => {
  it('adopts the manifest without claiming registry membership', () => {
    const root = tempDir('huabu-workspace-prepared-');

    prepareWorkspaceOnDisk(root);

    // Preparation runs inside a disposable child process. Creating the
    // manifest belongs there — it is part of the blocking filesystem work
    // being contained — but membership stays a Server-process decision so the
    // durable registry keeps exactly one writer and no stale cache to lose.
    expect(existsSync(path.join(root, '.workspace.json'))).toBe(true);
    expect(workspaceAtDirectory(root)).toBeNull();
  });
});
