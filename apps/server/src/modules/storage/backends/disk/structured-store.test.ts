import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { DiskStructuredStore } from './structured-store.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { toSafeFilename } from '../../../workspace/disk/naming.js';
import { describeCanvasLogRepositoryContract } from '../../ports/contracts/canvas-log-repository.contract.js';
import { describeSpaceRepositoryContract } from '../../ports/contracts/space-repository.contract.js';
import { describeStructuredStoreContract } from '../../ports/contracts/structured-store.contract.js';

import type { CanvasFile } from '../../../canvas/persistence-types.js';

/**
 * Seed a Space directly on disk.
 *
 * Deliberately not via the compatibility facade: an adapter test that reached
 * for `createCanvas` would make the Disk backend's own suite depend on the
 * layer that is supposed to be removable.
 *
 * The directory is named exactly `toSafeFilename(title, id)` so `read()`'s
 * Finder-rename self-heal sees nothing to reconcile and the fixture stays put.
 */
function seedSpace(root: string, canvasId: string, title: string): CanvasFile {
  const dir = path.join(root, toSafeFilename(title, canvasId));
  mkdirSync(dir, { recursive: true });
  const record: CanvasFile = {
    canvasId,
    title,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: 1,
    updatedAt: 1,
  };
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify(record), 'utf8');
  refreshCanvasDirIndex();
  return record;
}

function freshWorkspace(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  workspaceState.path = root;
  resetStorageCache();
  return root;
}

describeStructuredStoreContract('DiskStructuredStore', () => {
  const root = freshWorkspace('huabu-structured-');
  return {
    store: new DiskStructuredStore(),
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describeSpaceRepositoryContract('DiskSpaceRepository', () => {
  const root = freshWorkspace('huabu-space-repo-');
  seedSpace(root, 'canvas-a', 'Canvas A');
  const store = new DiskStructuredStore();
  return {
    repository: store.space('canvas-a').record,
    // A second composite over the same id. `space()` builds a fresh wrapper
    // per call, so these are independent objects sharing one cached instance
    // — which is exactly the shape the concurrency case needs.
    concurrent: store.space('canvas-a').record,
    missing: store.space('no-such-canvas').record,
    missingCanvasId: 'no-such-canvas',
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describeCanvasLogRepositoryContract('DiskCanvasLogRepository', () => {
  const root = freshWorkspace('huabu-log-repo-');
  seedSpace(root, 'canvas-a', 'Canvas A');
  const store = new DiskStructuredStore();
  return {
    logs: store.space('canvas-a').logs,
    concurrent: store.space('canvas-a').logs,
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

/**
 * Instance caching is a Disk adapter detail, so it is asserted here rather
 * than in the portable contract — including its limit, so the bound stays
 * visible if anyone is tempted to promise stable identity again.
 */
describe('DiskStructuredStore instance caching', () => {
  let root = '';

  beforeAll(() => {
    root = freshWorkspace('huabu-structured-cache-');
  });

  afterAll(() => {
    resetStorageCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses one underlying instance per id, up to the cache bound', () => {
    const first = getCanvasStore('canvas-a');
    expect(getCanvasStore('canvas-a')).toBe(first);

    // The instance cache is bounded, so a working set larger than the cache
    // evicts the oldest entry and the next call builds a fresh instance.
    // Callers must not treat a Space as a durable per-process singleton; see
    // the `space()` docs on `StructuredStore`.
    for (let i = 0; i < 20; i += 1) getCanvasStore(`filler-${i}`);

    const afterEviction = getCanvasStore('canvas-a');
    expect(afterEviction).not.toBe(first);
    expect(afterEviction.canvasId).toBe('canvas-a');
  });

  it('builds a fresh composite per call without caching one of its own', () => {
    const store = new DiskStructuredStore();
    const a = store.space('canvas-b');
    const b = store.space('canvas-b');

    // A second cache would have to be invalidated in lockstep with the
    // legacy one — `resetStorageCache()` clears only that map — so the
    // composite is deliberately rebuilt each call over the cached instance.
    expect(b).not.toBe(a);
    expect(b.canvasId).toBe(a.canvasId);
  });
});
