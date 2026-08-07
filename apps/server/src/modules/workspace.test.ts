import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  acquireWorkspaceOperationLease,
  commitWorkspacePath,
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
    const current = tempDir('sediment-workspace-current-');
    const next = tempDir('sediment-workspace-next-');
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
    const current = tempDir('sediment-workspace-current-');
    const parent = tempDir('sediment-workspace-parent-');
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
});
