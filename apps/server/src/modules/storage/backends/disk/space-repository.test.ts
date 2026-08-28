// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { WORLD_CANVAS_DIR_NAME } from './layout.js';
import { resetStorageCache } from './legacy/canvas-store-cache.js';
import { DiskSpaceRepository } from './space-repository.js';
import { DiskStructuredStore } from './structured-store.js';
import { toSafeFilename } from '../../../../utils/naming.js';
import { describeSpaceRepositoryContract } from '../../ports/contracts/space-repository.contract.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

const WORLD_ID = 'world-id';
const roots: string[] = [];

/**
 * Activate an empty Workspace.
 *
 * Deliberately does not go through `setWorkspacePath`, which prepares a World
 * on disk: several cases below assert behavior for a namespace whose World is
 * missing or malformed, so World creation has to stay explicit.
 */
function makeWorkspace(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  workspaceState.path = root;
  resetStorageCache();
  refreshCanvasDirIndex();
  return root;
}

function writeRecord(root: string, directory: string, value: unknown): void {
  const target = path.join(root, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'space.json'), JSON.stringify(value), 'utf8');
}

function record(
  canvasId: string,
  title: string | null,
  overrides: Partial<CanvasFile> = {},
): CanvasFile {
  return {
    canvasId,
    title,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function seedWorld(root: string, canvasId = WORLD_ID): void {
  writeRecord(root, WORLD_CANVAS_DIR_NAME, record(canvasId, 'World'));
  refreshCanvasDirIndex();
}

function seedSpace(
  root: string,
  canvasId: string,
  title: string | null,
  overrides: Partial<CanvasFile> = {},
): CanvasFile {
  const value = record(canvasId, title, overrides);
  writeRecord(root, toSafeFilename(title, canvasId), value);
  refreshCanvasDirIndex();
  return value;
}

afterEach(() => {
  resetStorageCache();
  refreshCanvasDirIndex();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describeSpaceRepositoryContract('Disk', () => {
  const root = makeWorkspace('huabu-space-repository-contract-');
  seedWorld(root);
  const store = new DiskStructuredStore();
  return {
    repository: store.spaces(),
    read: (canvasId: string) => store.space(canvasId).read(),
    attemptMutation: (canvasId: string) =>
      store.space(canvasId).nodes.put({
        nodeId: 'delete-fence-node',
        record: {
          nodeId: 'delete-fence-node',
          type: 'note',
          label: 'Delete fence node',
          content: 'body',
        },
      }),
    worldCanvasId: WORLD_ID,
    // A Disk namespace is a Workspace directory, so an unmounted one is a
    // fresh temp root with no `.world`. Activating it invalidates the store
    // above, which is exactly the licence the harness member documents.
    openEmptyNamespace: () => {
      makeWorkspace('huabu-space-repository-contract-empty-');
      const empty = new DiskStructuredStore();
      return {
        repository: empty.spaces(),
        read: (canvasId: string) => empty.space(canvasId).read(),
      };
    },
  };
});

describe('DiskSpaceRepository membership', () => {
  it('refreshes external additions, deletions, and directory renames', async () => {
    const root = makeWorkspace('huabu-space-membership-refresh-');
    seedWorld(root);
    seedSpace(root, 'canvas-a', 'Alpha');
    const spaces = new DiskSpaceRepository();

    await expect(spaces.list()).resolves.toMatchObject([
      { canvasId: 'canvas-a', title: 'Alpha' },
    ]);

    seedSpace(root, 'canvas-b', 'Beta');
    renameSync(path.join(root, 'Beta'), path.join(root, 'Finder Beta'));
    rmSync(path.join(root, 'Alpha'), { recursive: true });

    await expect(spaces.list()).resolves.toEqual([
      {
        canvasId: 'canvas-b',
        title: 'Finder Beta',
        nodeCount: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
  });

  it('coerces malformed summary fields without mutating the record', async () => {
    const root = makeWorkspace('huabu-space-membership-coercion-');
    seedWorld(root);
    const malformed = {
      canvasId: 'canvas-a',
      title: 42,
      version: 0,
      state: { nodes: 'invalid', edges: [] },
      createdAt: 'invalid',
    };
    writeRecord(root, 'canvas-a', malformed);
    const file = path.join(root, 'canvas-a', 'space.json');
    const before = readFileSync(file, 'utf8');
    const beforeMtime = statSync(file).mtimeMs;

    await expect(new DiskSpaceRepository().list()).resolves.toEqual([
      {
        canvasId: 'canvas-a',
        title: null,
        nodeCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
  });

  it('uses a Finder-renamed directory as display title without write-back', async () => {
    const root = makeWorkspace('huabu-space-membership-finder-');
    seedWorld(root);
    seedSpace(root, 'canvas-a', 'Alpha');
    renameSync(path.join(root, 'Alpha'), path.join(root, 'Renamed'));
    const file = path.join(root, 'Renamed', 'space.json');
    const before = readFileSync(file, 'utf8');
    const beforeMtime = statSync(file).mtimeMs;

    await expect(new DiskSpaceRepository().list()).resolves.toMatchObject([
      { canvasId: 'canvas-a', title: 'Renamed' },
    ]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
  });

  it('skips directories without a Space record and rejects malformed records', async () => {
    const root = makeWorkspace('huabu-space-membership-malformed-');
    seedWorld(root);
    mkdirSync(path.join(root, 'unrelated'));
    const spaces = new DiskSpaceRepository();
    await expect(spaces.list()).resolves.toEqual([]);

    writeFileSync(
      path.join(root, 'unrelated', 'space.json'),
      '{broken',
      'utf8',
    );
    await expect(spaces.list()).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    ['a non-object record', '[]'],
    ['a record without canvasId', '{}'],
  ])('rejects %s', async (_label, contents) => {
    const root = makeWorkspace('huabu-space-membership-invalid-');
    seedWorld(root);
    const target = path.join(root, 'invalid');
    mkdirSync(target);
    writeFileSync(path.join(target, 'space.json'), contents, 'utf8');

    await expect(new DiskSpaceRepository().list()).rejects.toThrow(
      /Invalid Space record/,
    );
  });

  it('rejects a missing or malformed World', async () => {
    const root = makeWorkspace('huabu-space-membership-world-');
    const spaces = new DiskSpaceRepository();
    await expect(spaces.list()).resolves.toEqual([]);
    await expect(spaces.worldId()).rejects.toThrow(/no World canvas/i);

    mkdirSync(path.join(root, WORLD_CANVAS_DIR_NAME));
    writeFileSync(
      path.join(root, WORLD_CANVAS_DIR_NAME, 'space.json'),
      '{broken',
      'utf8',
    );
    await expect(spaces.list()).rejects.toBeInstanceOf(SyntaxError);
    await expect(spaces.worldId()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('rejects a retained handle after the active Workspace changes', async () => {
    const firstRoot = makeWorkspace('huabu-space-membership-stale-a-');
    seedWorld(firstRoot, 'world-a');
    const held = new DiskSpaceRepository();
    await expect(held.worldId()).resolves.toBe('world-a');

    const secondRoot = makeWorkspace('huabu-space-membership-stale-b-');
    seedWorld(secondRoot, 'world-b');
    await expect(held.list()).rejects.toThrow(/inactive workspace/i);
    await expect(held.worldId()).rejects.toThrow(/inactive workspace/i);
    await expect(new DiskSpaceRepository().worldId()).resolves.toBe('world-b');
  });
});

describe('DiskSpaceRepository lifecycle', () => {
  it('persists the de-duplicated title and reports explicit delete outcomes', async () => {
    const root = makeWorkspace('huabu-space-lifecycle-titles-');
    seedWorld(root);
    const spaces = new DiskSpaceRepository(() => 1);
    const first = await spaces.create({
      canvasId: 'canvas-a',
      title: 'Shared title',
    });
    const second = await spaces.create({
      canvasId: 'canvas-b',
      title: 'Shared title',
    });

    expect(first).toMatchObject({
      ok: true,
      record: { title: 'Shared title' },
    });
    expect(second).toMatchObject({
      ok: true,
      record: { title: 'Shared title (2)' },
    });
    const deletion = await spaces.beginDelete({ canvasId: 'canvas-b' });
    if (!deletion.ok) throw new Error('ordinary Space must be deletable');
    await expect(deletion.session.finish()).resolves.toEqual({
      ok: true,
      reason: 'deleted',
    });
    const missing = await spaces.beginDelete({ canvasId: 'canvas-b' });
    if (!missing.ok) throw new Error('missing Space must be cleanable');
    await expect(missing.session.finish()).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refreshes membership before allocating around an externally imported Space', async () => {
    const root = makeWorkspace('huabu-space-lifecycle-imported-');
    seedWorld(root);
    const spaces = new DiskSpaceRepository(() => 1);
    await spaces.create({ canvasId: 'warm-index', title: 'Warm index' });
    const importedRoot = path.join(root, 'Taken');
    mkdirSync(importedRoot, { recursive: true });
    const imported = {
      canvasId: 'external-space',
      title: 'Taken',
      version: 7,
      state: { nodes: [], edges: [] },
      createdAt: 2,
      updatedAt: 3,
    };
    writeFileSync(
      path.join(importedRoot, 'space.json'),
      JSON.stringify(imported),
      'utf8',
    );

    const created = await spaces.create({
      canvasId: 'new-space',
      title: 'Taken',
    });

    expect(created).toMatchObject({
      ok: true,
      record: { canvasId: 'new-space', title: 'Taken (2)' },
    });
    expect(
      JSON.parse(readFileSync(path.join(importedRoot, 'space.json'), 'utf8')),
    ).toEqual(imported);
  });

  it('keeps an allocated null title consistent in the record and the listing', async () => {
    const root = makeWorkspace('huabu-space-lifecycle-null-title-');
    seedWorld(root);
    const spaces = new DiskSpaceRepository(() => 1);
    await spaces.create({
      canvasId: 'physical-name-owner',
      title: 'null-title-space',
    });
    const created = await spaces.create({
      canvasId: 'null-title-space',
      title: null,
    });

    expect(created).toMatchObject({ ok: true, record: { title: null } });
    await expect(spaces.list()).resolves.toContainEqual(
      expect.objectContaining({ canvasId: 'null-title-space', title: null }),
    );
  });
});
