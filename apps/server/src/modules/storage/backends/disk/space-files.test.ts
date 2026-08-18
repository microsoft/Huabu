// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DiskSpaceFiles } from './space-files.js';
import { setWorkspacePath } from '../../../workspace.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-space-files-'));
  roots.push(root);
  setWorkspacePath(root);
  return root;
}

function record(canvasId: string): CanvasFile {
  return {
    canvasId,
    title: 'Imported Space',
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('DiskSpaceFiles', () => {
  it('publishes an imported materialization without exposing Disk layout to the route', async () => {
    const root = workspace();
    const files = new DiskSpaceFiles(root);
    const staged = await files.stageImport('canvas-imported');
    mkdirSync(path.join(staged.directory, 'nodes'), { recursive: true });
    writeFileSync(
      path.join(staged.directory, 'nodes', 'Note.md'),
      '---\nid: node-a\n---\nBody',
      'utf8',
    );
    writeFileSync(path.join(staged.directory, 'canvas.json'), '{}', 'utf8');

    const published = await staged.publish(record('canvas-imported'));
    const scope = files.space('canvas-imported');

    expect(published.title).toBe('Imported Space');
    expect(scope.directory()).toBe(path.join(root, 'Imported Space'));
    expect(scope.nodesDirectory()).toBe(
      path.join(root, 'Imported Space', 'nodes'),
    );
    expect(
      JSON.parse(
        readFileSync(path.join(scope.directory(), 'space.json'), 'utf8'),
      ),
    ).toEqual(published);
    expect(existsSync(path.join(scope.directory(), 'canvas.json'))).toBe(false);
    expect(existsSync(path.join(scope.nodesDirectory(), 'Note.md'))).toBe(true);
  });

  it('fences a retained file scope after Workspace activation changes', async () => {
    const first = workspace();
    const files = new DiskSpaceFiles(first);
    const scope = files.space('canvas-a');
    workspace();

    expect(() => scope.directory()).toThrow('inactive workspace');
    await expect(files.stageImport('canvas-imported')).rejects.toThrow(
      'inactive Workspace',
    );
  });
});
