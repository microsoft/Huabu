// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  acquireWorkspaceOperationLease,
  commitWorkspacePath,
  getWorkspaceHandle,
  getWorkspacePath,
  setWorkspacePath,
  WorkspaceOperationInProgressError,
} from './workspace.js';

describe('workspace operation leases', () => {
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

  it('keeps the active path and manifest identity in one Workspace handle', () => {
    const current = tempDir('huabu-workspace-handle-');
    setWorkspacePath(current);

    const handle = getWorkspaceHandle();
    expect(handle).toMatchObject({
      workspacePath: path.resolve(current),
      name: path.basename(current),
    });
    expect(handle?.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
