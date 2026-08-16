// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { canvasRoot } from './paths.js';
import { setWorkspacePath } from '../../workspace.js';

describe('Disk Workspace paths', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(path.join(tmpdir(), 'huabu-paths-'));
    setWorkspacePath(workspacePath);
    refreshCanvasDirIndex();
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('resolves Canvas roots within the active Workspace', () => {
    const resolved = canvasRoot('canvas-a');
    const workspaceRoot = path.resolve(workspacePath);

    expect(resolved).toBe(path.join(workspaceRoot, 'canvas-a'));
    expect(resolved.startsWith(`${workspaceRoot}${path.sep}`)).toBe(true);
  });

  it.each(['../escape', 'nested/canvas', '/absolute'])(
    'rejects a Canvas id that could escape the Workspace: %s',
    (canvasId) => {
      expect(() => canvasRoot(canvasId)).toThrow(/Invalid canvasId/);
    },
  );
});
