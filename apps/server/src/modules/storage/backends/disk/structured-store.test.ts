import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { resetStorageCache } from './legacy/canvas-store-cache.js';
import { DiskStructuredStore } from './structured-store.js';
import { describeStructuredStoreContract } from '../../ports/contracts/structured-store.contract.js';

describeStructuredStoreContract('DiskStructuredStore', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'huabu-structured-'));
  workspaceState.path = root;
  resetStorageCache();
  return {
    store: new DiskStructuredStore(),
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

/**
 * Handle caching is a Disk adapter detail, so it is asserted here rather
 * than in the portable contract — including its limit, so the bound stays
 * visible if anyone is tempted to promise stable identity again.
 */
describe('DiskStructuredStore handle caching', () => {
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'huabu-structured-cache-'));
    workspaceState.path = root;
    resetStorageCache();
  });

  afterAll(() => {
    resetStorageCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses one instance per id, up to the cache bound', () => {
    const store = new DiskStructuredStore();
    const first = store.space('canvas-a');

    expect(store.space('canvas-a')).toBe(first);

    // The instance cache is bounded, so a working set larger than the cache
    // evicts the oldest entry and the next call builds a fresh instance.
    // Callers must not treat a handle as a durable per-Space singleton; see
    // the `space()` docs on `StructuredStore`.
    for (let i = 0; i < 20; i += 1) store.space(`filler-${i}`);

    const afterEviction = store.space('canvas-a');
    expect(afterEviction).not.toBe(first);
    expect(afterEviction.canvasId).toBe('canvas-a');
  });
});
