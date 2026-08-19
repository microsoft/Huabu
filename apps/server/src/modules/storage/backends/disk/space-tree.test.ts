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

import { DiskSpaceTrees } from './space-tree.js';
import { setWorkspacePath } from '../../../workspace.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-space-tree-'));
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

describe('DiskSpaceTrees', () => {
  it('publishes an imported bundle into the Space namespace', async () => {
    const root = workspace();
    const trees = new DiskSpaceTrees(root);
    const staged = await trees.stageImport('canvas-imported');
    mkdirSync(path.join(staged.directory, 'nodes'), { recursive: true });
    writeFileSync(
      path.join(staged.directory, 'nodes', 'Note.md'),
      '---\nid: node-a\n---\nBody',
      'utf8',
    );
    writeFileSync(path.join(staged.directory, 'canvas.json'), '{}', 'utf8');

    const published = await staged.publish(record('canvas-imported'));
    const tree = trees.space('canvas-imported');

    expect(published.title).toBe('Imported Space');
    expect(tree.directory()).toBe(path.join(root, 'Imported Space'));
    expect(tree.nodesDirectory()).toBe(
      path.join(root, 'Imported Space', 'nodes'),
    );
    expect(
      JSON.parse(
        readFileSync(path.join(tree.directory(), 'space.json'), 'utf8'),
      ),
    ).toEqual(published);
    // The legacy record name never survives an import.
    expect(existsSync(path.join(tree.directory(), 'canvas.json'))).toBe(false);
    expect(existsSync(path.join(tree.nodesDirectory(), 'Note.md'))).toBe(true);
  });

  it('adjusts the title when the directory name it wants is taken', async () => {
    const root = workspace();
    const trees = new DiskSpaceTrees(root);
    mkdirSync(path.join(root, 'Imported Space'), { recursive: true });
    writeFileSync(
      path.join(root, 'Imported Space', 'space.json'),
      JSON.stringify(record('canvas-existing')),
      'utf8',
    );
    const staged = await trees.stageImport('canvas-imported');

    const published = await staged.publish(record('canvas-imported'));

    // The caller must use the returned record: the directory is derived from
    // the title, so allocating a free name changes the title with it.
    expect(published.title).not.toBe('Imported Space');
    expect(trees.space('canvas-imported').directory()).toBe(
      path.join(root, published.title as string),
    );
  });

  it('discards a staged bundle that was never published', async () => {
    const root = workspace();
    const trees = new DiskSpaceTrees(root);
    const staged = await trees.stageImport('canvas-discard');
    writeFileSync(path.join(staged.directory, 'seed.txt'), 'body', 'utf8');

    await staged.discard();

    expect(existsSync(staged.directory)).toBe(false);
  });

  it('refuses a bundle addressed to another Space, and a second publish', async () => {
    const root = workspace();
    const trees = new DiskSpaceTrees(root);
    const staged = await trees.stageImport('canvas-imported');

    await expect(staged.publish(record('canvas-other'))).rejects.toThrow(
      'id mismatch',
    );
    await staged.publish(record('canvas-imported'));
    await expect(staged.publish(record('canvas-imported'))).rejects.toThrow(
      'already published',
    );
  });

  it('resolves a node file through the sidecar index, not its name', async () => {
    const root = workspace();
    const trees = new DiskSpaceTrees(root);
    const staged = await trees.stageImport('canvas-imported');
    mkdirSync(path.join(staged.directory, 'nodes'), { recursive: true });
    writeFileSync(
      path.join(staged.directory, 'nodes', 'Note.md'),
      '---\nid: node-a\n---\nBody',
      'utf8',
    );
    await staged.publish(record('canvas-imported'));
    const tree = trees.space('canvas-imported');

    // A node is filed under its label, so only the index can invert it.
    await expect(tree.nodeIdForPath('nodes/Note.md')).resolves.toBe('node-a');
    // Nothing else in a Space carries a node record.
    await expect(tree.nodeIdForPath('nodes/Missing.md')).resolves.toBeNull();
    await expect(tree.nodeIdForPath('setting/user.md')).resolves.toBeNull();
    await expect(tree.nodeIdForPath('nodes/deep/x.md')).resolves.toBeNull();
  });

  it('fences a retained tree after Workspace activation changes', async () => {
    const first = workspace();
    const trees = new DiskSpaceTrees(first);
    const tree = trees.space('canvas-a');
    workspace();

    expect(() => tree.directory()).toThrow('inactive workspace');
    expect(() => tree.nodesDirectory()).toThrow('inactive workspace');
    await expect(trees.stageImport('canvas-imported')).rejects.toThrow(
      'inactive Workspace',
    );
  });
});
