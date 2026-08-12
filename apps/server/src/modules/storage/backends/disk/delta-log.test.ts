// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Disk's executor journal.
 *
 * Tested here rather than through a portable suite: `delta-log.jsonl` is not a
 * part of a Space that `SpaceHandle` exposes. A write takes the row as an
 * argument and the application never reads it back, so its append ordering and
 * validation are Disk's own durable-state concern.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { createDiskDeltaLog } from './space-logs.js';
import { DiskSpaceRepository } from './space-repository.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { ensureWorldCanvasOnDisk } from '../../../workspace/disk/world-canvas.js';
import { setWorkspacePath } from '../../../workspace.js';

import type { DiskDeltaLog } from './space-logs.js';
import type { DeltaLogEntry } from '../../../canvas/persistence-types.js';

function delta(version: number): DeltaLogEntry {
  return {
    version,
    ts: 1_000 + version,
    commands: [],
    deltas: [],
    originator: { source: 'agent' },
  };
}

describe('Disk executor journal', () => {
  let root = '';
  let journal: DiskDeltaLog;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'huabu-delta-log-'));
    setWorkspacePath(root);
    resetStorageCache();
    ensureWorldCanvasOnDisk(root);
    refreshCanvasDirIndex();
    const created = await new DiskSpaceRepository().create({
      canvasId: 'canvas-a',
      title: 'Journal Space',
    });
    if (!created.ok) throw new Error('test Space already exists');
    journal = createDiskDeltaLog(getCanvasStore('canvas-a'));
  });

  afterEach(() => {
    resetStorageCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads an empty journal as an empty list', async () => {
    await expect(journal.readSince(0)).resolves.toEqual([]);
  });

  it('filters rows strictly greater than the requested version', async () => {
    await journal.append(delta(1));
    await journal.append(delta(2));
    await journal.append(delta(3));

    expect((await journal.readSince(0)).map((d) => d.version)).toEqual([
      1, 2, 3,
    ]);
    expect((await journal.readSince(2)).map((d) => d.version)).toEqual([3]);
    expect(await journal.readSince(3)).toEqual([]);
  });

  it('rejects a duplicate or out-of-order version', async () => {
    await journal.append(delta(1));
    await journal.append(delta(5));

    await expect(journal.append(delta(5))).rejects.toThrow();
    await expect(journal.append(delta(2))).rejects.toThrow();

    // The rejected appends left nothing behind.
    expect((await journal.readSince(0)).map((d) => d.version)).toEqual([1, 5]);
  });

  it('lets exactly one of two appends racing from one tick claim a version', async () => {
    await journal.append(delta(1));
    const concurrent = createDiskDeltaLog(getCanvasStore('canvas-a'));

    // Issued from one tick with no intervening await: an implementation that
    // `await`s between its tail read and its append lets both observe version
    // 1 as the head and both write version 2. Same constraint as the ordered
    // Space write; see `createDiskSpaceWrite`.
    const results = await Promise.allSettled([
      journal.append(delta(2)),
      concurrent.append(delta(2)),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await journal.readSince(0)).map((d) => d.version)).toEqual([1, 2]);
  });
});
