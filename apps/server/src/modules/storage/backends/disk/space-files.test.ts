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

import { AddressedSpaceFiles } from './space-files-addressed.js';
import { DiskSpaceFiles } from './space-files.js';
import { setWorkspacePath } from '../../../workspace.js';
import { describeSpaceFilesContract } from '../../ports/contracts/space-files.contract.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { SpaceFiles } from '../../ports/files.js';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-space-files-'));
  roots.push(root);
  setWorkspacePath(root);
  return root;
}

/**
 * Both materializations against the same suite.
 *
 * This is what makes the capability an interface rather than a description of
 * the Disk layout: the addressing differs completely, and nothing in the
 * shared contract notices.
 */
function contractHarness(files: (root: string) => SpaceFiles) {
  return () => {
    const root = workspace();
    const capability = files(root);
    return {
      files: capability,
      switchWorkspace: (): void => {
        workspace();
      },
      exists: (canvasId: string, relativePath: string): boolean =>
        existsSync(
          path.join(
            capability.space(canvasId).directory(),
            ...relativePath.split('/'),
          ),
        ),
      writeFile: (
        directory: string,
        relativePath: string,
        contents: string,
      ): void => {
        const target = path.join(directory, ...relativePath.split('/'));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, contents, 'utf8');
      },
    };
  };
}

describeSpaceFilesContract(
  'Disk (title-addressed)',
  contractHarness((root) => new DiskSpaceFiles(root)),
);

describeSpaceFilesContract(
  'Disk (id-addressed)',
  contractHarness((root) => new AddressedSpaceFiles(root)),
);

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

  it('resolves a node file through the sidecar index, not its name', async () => {
    const root = workspace();
    const files = new DiskSpaceFiles(root);
    const staged = await files.stageImport('canvas-imported');
    mkdirSync(path.join(staged.directory, 'nodes'), { recursive: true });
    writeFileSync(
      path.join(staged.directory, 'nodes', 'Note.md'),
      '---\nid: node-a\n---\nBody',
      'utf8',
    );
    await staged.publish(record('canvas-imported'));

    // The file is named for its label, so only the index can invert it.
    await expect(
      files.space('canvas-imported').nodeIdForPath('nodes/Note.md'),
    ).resolves.toBe('node-a');
  });
});

describe('AddressedSpaceFiles', () => {
  it('addresses a Space and its nodes by stable id alone', async () => {
    const root = workspace();
    const files = new AddressedSpaceFiles(root);
    const scope = files.space('canvas-imported');

    expect(scope.directory()).toBe(path.join(root, 'canvas-imported'));
    expect(scope.nodesDirectory()).toBe(
      path.join(root, 'canvas-imported', 'nodes'),
    );
    await expect(scope.nodeIdForPath('nodes/node-a.md')).resolves.toBe(
      'node-a',
    );
  });

  it('publishes an import without allocating a name or touching the title', async () => {
    const root = workspace();
    const files = new AddressedSpaceFiles(root);
    // A Space already occupies the title this import asks for. A
    // title-addressed layout would have to dedupe; this one never looks.
    mkdirSync(path.join(root, 'Imported Space'), { recursive: true });
    const staged = await files.stageImport('canvas-imported');
    mkdirSync(path.join(staged.directory, 'nodes'), { recursive: true });
    writeFileSync(
      path.join(staged.directory, 'nodes', 'node-a.md'),
      'Body',
      'utf8',
    );

    const published = await staged.publish(record('canvas-imported'));

    expect(published.title).toBe('Imported Space');
    expect(
      existsSync(path.join(root, 'canvas-imported', 'nodes', 'node-a.md')),
    ).toBe(true);
  });
});
