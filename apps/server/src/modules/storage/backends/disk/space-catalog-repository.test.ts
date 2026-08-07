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

import { DiskStructuredStore } from './structured-store.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { toSafeFilename } from '../../../workspace/disk/naming.js';
import { WORLD_CANVAS_DIR_NAME } from '../../../workspace/disk/paths.js';
import { describeSpaceCatalogRepositoryContract } from '../../ports/contracts/space-catalog-repository.contract.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';
import type { CanvasSummary } from '@sediment/shared';

const roots: string[] = [];

function makeWorkspace(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  workspaceState.path = root;
  refreshCanvasDirIndex();
  return root;
}

function writeRecord(root: string, directory: string, record: unknown): void {
  const target = path.join(root, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    path.join(target, 'space.json'),
    JSON.stringify(record),
    'utf8',
  );
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

function seedWorld(root: string, canvasId = 'world-id'): void {
  writeRecord(root, WORLD_CANVAS_DIR_NAME, record(canvasId, 'World'));
}

function seedSpace(
  root: string,
  canvasId: string,
  title: string | null,
  overrides: Partial<CanvasFile> = {},
): CanvasFile {
  const value = record(canvasId, title, overrides);
  writeRecord(root, toSafeFilename(title, canvasId), value);
  return value;
}

afterEach(() => {
  refreshCanvasDirIndex();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describeSpaceCatalogRepositoryContract(
  'DiskSpaceCatalogRepository',
  (scenario) => {
    const root = makeWorkspace('sediment-space-catalog-contract-');
    seedWorld(root);
    const expectedSummaries: CanvasSummary[] = [];
    if (scenario === 'populated') {
      const first = seedSpace(root, 'canvas-a', 'Alpha', {
        state: { nodes: [{ id: 'n1' }], edges: [] },
        createdAt: 10,
        updatedAt: 20,
      });
      const second = seedSpace(root, 'canvas-b', null, {
        createdAt: 30,
        updatedAt: 40,
      });
      expectedSummaries.push(
        {
          canvasId: first.canvasId,
          title: first.title,
          nodeCount: 1,
          createdAt: first.createdAt,
          updatedAt: first.updatedAt,
        },
        {
          canvasId: second.canvasId,
          title: second.title,
          nodeCount: 0,
          createdAt: second.createdAt,
          updatedAt: second.updatedAt,
        },
      );
    }

    return {
      repository: new DiskStructuredStore().catalog(),
      expectedSummaries,
      expectedWorldId: 'world-id',
    };
  },
);

describe('DiskSpaceCatalogRepository', () => {
  it('refreshes external additions, deletions, and directory renames', async () => {
    const root = makeWorkspace('sediment-space-catalog-refresh-');
    seedWorld(root);
    seedSpace(root, 'canvas-a', 'Alpha');
    const catalog = new DiskStructuredStore().catalog();

    await expect(catalog.list()).resolves.toMatchObject([
      { canvasId: 'canvas-a', title: 'Alpha' },
    ]);

    seedSpace(root, 'canvas-b', 'Beta');
    renameSync(path.join(root, 'Beta'), path.join(root, 'Finder Beta'));
    rmSync(path.join(root, 'Alpha'), { recursive: true });

    await expect(catalog.list()).resolves.toEqual([
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
    const root = makeWorkspace('sediment-space-catalog-coercion-');
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

    await expect(new DiskStructuredStore().catalog().list()).resolves.toEqual([
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
    const root = makeWorkspace('sediment-space-catalog-finder-');
    seedWorld(root);
    seedSpace(root, 'canvas-a', 'Alpha');
    renameSync(path.join(root, 'Alpha'), path.join(root, 'Renamed'));
    const file = path.join(root, 'Renamed', 'space.json');
    const before = readFileSync(file, 'utf8');
    const beforeMtime = statSync(file).mtimeMs;

    await expect(
      new DiskStructuredStore().catalog().list(),
    ).resolves.toMatchObject([{ canvasId: 'canvas-a', title: 'Renamed' }]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
  });

  it('skips directories without a Space record and rejects malformed records', async () => {
    const root = makeWorkspace('sediment-space-catalog-malformed-');
    seedWorld(root);
    mkdirSync(path.join(root, 'unrelated'));
    const catalog = new DiskStructuredStore().catalog();
    await expect(catalog.list()).resolves.toEqual([]);

    writeFileSync(
      path.join(root, 'unrelated', 'space.json'),
      '{broken',
      'utf8',
    );
    await expect(catalog.list()).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    ['a non-object record', '[]'],
    ['a record without canvasId', '{}'],
  ])('rejects %s', async (_label, contents) => {
    const root = makeWorkspace('sediment-space-catalog-invalid-');
    seedWorld(root);
    const target = path.join(root, 'invalid');
    mkdirSync(target);
    writeFileSync(path.join(target, 'space.json'), contents, 'utf8');

    await expect(new DiskStructuredStore().catalog().list()).rejects.toThrow(
      /Invalid Space record/,
    );
  });

  it('rejects a missing or malformed World', async () => {
    const root = makeWorkspace('sediment-space-catalog-world-');
    const catalog = new DiskStructuredStore().catalog();
    await expect(catalog.list()).resolves.toEqual([]);
    await expect(catalog.worldId()).rejects.toThrow(/no World canvas/i);

    mkdirSync(path.join(root, WORLD_CANVAS_DIR_NAME));
    writeFileSync(
      path.join(root, WORLD_CANVAS_DIR_NAME, 'space.json'),
      '{broken',
      'utf8',
    );
    await expect(catalog.list()).rejects.toBeInstanceOf(SyntaxError);
    await expect(catalog.worldId()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('rejects a retained handle after the active Workspace changes', async () => {
    const firstRoot = makeWorkspace('sediment-space-catalog-stale-a-');
    seedWorld(firstRoot, 'world-a');
    const held = new DiskStructuredStore().catalog();
    await expect(held.worldId()).resolves.toBe('world-a');

    const secondRoot = makeWorkspace('sediment-space-catalog-stale-b-');
    seedWorld(secondRoot, 'world-b');
    await expect(held.list()).rejects.toThrow(/inactive workspace/i);
    await expect(held.worldId()).rejects.toThrow(/inactive workspace/i);
    await expect(new DiskStructuredStore().catalog().worldId()).resolves.toBe(
      'world-b',
    );
  });
});
