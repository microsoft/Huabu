import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import {
  canvasDirName,
  getWorldCanvasId,
  isWorldCanvasId,
  listAllCanvasDirEntries,
  listCanvasDirEntries,
  refreshCanvasDirIndex,
  renameCanvasDirOnDisk,
  suggestCanvasDir,
} from './canvas-dirs.js';
import { CanvasStore } from '../../storage/index.js';

function writeCanvas(
  root: string,
  directory: string,
  canvasId: string,
  title: string,
): void {
  const canvasRoot = path.join(root, directory);
  mkdirSync(canvasRoot, { recursive: true });
  writeFileSync(
    path.join(canvasRoot, 'space.json'),
    JSON.stringify({
      canvasId,
      title,
      version: 0,
      state: { nodes: [], edges: [] },
      createdAt: 1,
      updatedAt: 1,
    }),
    'utf8',
  );
}

beforeEach(() => {
  workspaceState.path = mkdtempSync(
    path.join(tmpdir(), 'sediment-world-index-'),
  );
  writeCanvas(workspaceState.path, '.world', 'canvas-world', 'World');
  writeCanvas(workspaceState.path, 'Project A', 'canvas-a', 'Project A');
  refreshCanvasDirIndex();
});

afterEach(() => {
  rmSync(workspaceState.path, { recursive: true, force: true });
});

describe('World canvas directory indexing', () => {
  it('resolves World internally while omitting it from ordinary lists', () => {
    expect(getWorldCanvasId()).toBe('canvas-world');
    expect(isWorldCanvasId('canvas-world')).toBe(true);
    expect(canvasDirName('canvas-world')).toBe('.world');
    expect(listCanvasDirEntries().map((entry) => entry.id)).toEqual([
      'canvas-a',
    ]);
    expect(
      listAllCanvasDirEntries()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(['canvas-a', 'canvas-world']);
    expect(suggestCanvasDir('.world', 'canvas-b')).not.toBe('.world');
    expect(renameCanvasDirOnDisk('canvas-a', '.world')).toEqual({
      ok: false,
      reason: 'conflict',
      conflictWith: '.world',
    });
  });

  it('does not adopt the hidden directory name as the World title', () => {
    const store = new CanvasStore('canvas-world');

    expect(store.read()?.title).toBe('World');
    expect(store.renameSelf('Renamed')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(() => store.destroy()).toThrow('World canvas cannot be deleted');

    const persisted = JSON.parse(
      readFileSync(
        path.join(workspaceState.path, '.world', 'space.json'),
        'utf8',
      ),
    ) as { title: string };
    expect(persisted.title).toBe('World');
  });

  it('rejects malformed World topology during a runtime rescan', () => {
    writeFileSync(
      path.join(workspaceState.path, '.world', 'space.json'),
      JSON.stringify({
        canvasId: 'canvas-world',
        state: { nodes: [] },
      }),
      'utf8',
    );
    refreshCanvasDirIndex();

    expect(() => getWorldCanvasId()).toThrow(
      'World canvas is missing or malformed',
    );
  });
});
