import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { DiskBlobStore } from './backends/disk-blob.js';
import { DiskStructuredStore } from './backends/disk-structured.js';
import { resetStorageCache } from './canvas-store-cache.js';
import { setStorageForTesting, type Storage } from './storage.js';
import { refreshCanvasDirIndex } from '../workspace/disk/canvas-dirs.js';
import { artifactPath, canvasJsonPath } from '../workspace/disk/paths.js';

import { deleteCanvas } from './index.js';

import type {
  BlobInfo,
  BlobRange,
  BlobRead,
  BlobScope,
  BlobScopeRef,
  BlobStore,
} from './ports/blob.js';
import type { Readable } from 'node:stream';

function writeCanvas(directory: string, canvasId: string, title: string): void {
  const root = path.join(workspaceState.path, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'space.json'),
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

/**
 * Wraps the real disk blob store and records whether the Space's structured
 * record still existed at the moment its blobs were swept.
 *
 * On Disk both end up gone either way, so the ordering that
 * docs/proposals/multi-backend-storage.md §8 cares about — blobs first,
 * while something still names them — is only observable from inside the
 * sweep.
 */
class OrderRecordingBlobStore implements BlobStore {
  readonly kind = 'disk' as const;
  readonly recordPresentAtSweep: boolean[] = [];

  private readonly inner = new DiskBlobStore();

  init(): Promise<void> {
    return this.inner.init();
  }

  health(): ReturnType<BlobStore['health']> {
    return this.inner.health();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  scope(ref: BlobScopeRef): BlobScope {
    const scope = this.inner.scope(ref);
    const seen = this.recordPresentAtSweep;
    return {
      put: (name: string, body: Readable | Buffer): Promise<BlobInfo> =>
        scope.put(name, body),
      head: (name: string): Promise<BlobInfo | null> => scope.head(name),
      open: (name: string, range?: BlobRange): Promise<BlobRead | null> =>
        scope.open(name, range),
      read: (name: string): Promise<Buffer | null> => scope.read(name),
      hasMany: (names: readonly string[]): Promise<ReadonlySet<string>> =>
        scope.hasMany(names),
      list: (): Promise<BlobInfo[]> => scope.list(),
      materialize: (name: string) => scope.materialize(name),
      deleteAll: async (): Promise<void> => {
        seen.push(existsSync(canvasJsonPath(ref.canvasId)));
        await scope.deleteAll();
      },
    };
  }
}

let blobs: OrderRecordingBlobStore;
let restoreStorage: () => void;

beforeEach(() => {
  workspaceState.path = mkdtempSync(path.join(tmpdir(), 'sediment-delete-'));
  writeCanvas('.world', 'canvas-world', 'World');
  writeCanvas('Project A', 'canvas-a', 'Project A');
  refreshCanvasDirIndex();
  resetStorageCache();

  blobs = new OrderRecordingBlobStore();
  restoreStorage = setStorageForTesting({
    profile: { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
    structured: new DiskStructuredStore(),
    blobs,
  } satisfies Storage);
});

afterEach(() => {
  restoreStorage();
  resetStorageCache();
  rmSync(workspaceState.path, { recursive: true, force: true });
});

describe('deleteCanvas', () => {
  it('sweeps blobs while the record that names them still exists', async () => {
    mkdirSync(path.dirname(artifactPath('canvas-a', 'art_1.png')), {
      recursive: true,
    });
    writeFileSync(artifactPath('canvas-a', 'art_1.png'), 'bytes');

    await expect(deleteCanvas('canvas-a')).resolves.toBe(true);

    // Blobs first: after the structured record is gone nothing names them,
    // so a failed sweep on a remote backend would strand them permanently.
    expect(blobs.recordPresentAtSweep).toEqual([true]);
    expect(existsSync(artifactPath('canvas-a', 'art_1.png'))).toBe(false);
    expect(existsSync(canvasJsonPath('canvas-a'))).toBe(false);
  });

  it('reports a Space that was already gone', async () => {
    await expect(deleteCanvas('canvas-missing')).resolves.toBe(false);
  });

  it('refuses the World canvas without touching its blobs', async () => {
    mkdirSync(path.dirname(artifactPath('canvas-world', 'art_w.png')), {
      recursive: true,
    });
    writeFileSync(artifactPath('canvas-world', 'art_w.png'), 'bytes');

    await expect(deleteCanvas('canvas-world')).rejects.toThrow(
      'World canvas cannot be deleted',
    );

    // The refusal has to come before the sweep: with blobs deleted first, a
    // guard that lived only in `destroy()` would already have cost the World
    // its artifacts by the time it threw.
    expect(blobs.recordPresentAtSweep).toEqual([]);
    expect(existsSync(artifactPath('canvas-world', 'art_w.png'))).toBe(true);
    expect(existsSync(canvasJsonPath('canvas-world'))).toBe(true);
  });
});
