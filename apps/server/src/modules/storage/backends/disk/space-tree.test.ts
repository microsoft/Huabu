// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { resetStorageCache } from './legacy/canvas-store-cache.js';
import { diskSpaceTree } from './space-tree.js';
import { ensureWorldCanvasOnDisk } from './world-canvas.js';
import { setWorkspacePath } from '../../../workspace.js';

const roots: string[] = [];

function freshWorkspace(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  setWorkspacePath(root);
  resetStorageCache();
  ensureWorldCanvasOnDisk(root);
  refreshCanvasDirIndex();
  return path.resolve(root);
}

describe('diskSpaceTree', () => {
  afterEach(() => {
    resetStorageCache();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves inside the Workspace that was active when it was made', () => {
    const workspace = freshWorkspace('huabu-space-tree-');

    const tree = diskSpaceTree('space-a');

    expect(tree.canvasId).toBe('space-a');
    expect(tree.directory()).toBe(path.join(workspace, 'space-a'));
  });

  it('rejects a retained tree instead of following a Workspace switch', () => {
    freshWorkspace('huabu-space-tree-first-');
    const retained = diskSpaceTree('space-a');
    const second = freshWorkspace('huabu-space-tree-second-');

    // Every other member of the Space handle already refuses an inactive
    // Workspace. A directory that answered here would hand a caller the
    // *other* Workspace's files under the id it asked about — the file tools'
    // sandbox root and bundle export both resolve real paths from it.
    expect(() => retained.directory()).toThrow(/inactive workspace/);
    expect(() => retained.nodeIdForPath('nodes/Note.md')).toThrow(
      /inactive workspace/,
    );
    expect(() => retained.nodesDirectory()).toThrow(/inactive workspace/);
    expect(() => retained.duplicateSidecars('node-a')).toThrow(
      /inactive workspace/,
    );
    expect(diskSpaceTree('space-a').directory()).toBe(
      path.join(second, 'space-a'),
    );
  });
});
