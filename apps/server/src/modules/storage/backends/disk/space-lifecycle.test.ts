// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetStorageCache } from './legacy/canvas-store-cache.js';
import {
  DiskSpaceLifecycleRepository,
  type DiskLifecycleJournal,
} from './space-lifecycle.js';
import {
  abortPreparedDiskTransaction,
  applyPreparedDiskTransaction,
  finalizeCommittedDiskTransaction,
  markPreparedDiskTransactionCommitted,
  prepareDiskTransaction,
} from './transaction-journal.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import {
  canvasJsonPath,
  workspaceTransactionsDir,
} from '../../../workspace/disk/paths.js';
import { setWorkspacePath } from '../../../workspace.js';

function realJournal(): DiskLifecycleJournal {
  return {
    prepare: prepareDiskTransaction,
    apply: applyPreparedDiskTransaction,
    markCommitted: markPreparedDiskTransactionCommitted,
    finalize: finalizeCommittedDiskTransaction,
    abort: abortPreparedDiskTransaction,
  };
}

describe('DiskSpaceLifecycleRepository journal failures', () => {
  let workspace = '';

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'huabu-lifecycle-failure-'));
    setWorkspacePath(workspace);
    resetStorageCache();
  });

  afterEach(() => {
    resetStorageCache();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('rolls an interrupted create back out of the catalogue', async () => {
    const journal = realJournal();
    const lifecycle = new DiskSpaceLifecycleRepository(
      {
        ...journal,
        apply(transaction): void {
          journal.apply(transaction);
          throw new Error('injected create interruption');
        },
      },
      () => 42,
    );

    await expect(
      lifecycle.create({ canvasId: 'create-failure', title: 'Create Failure' }),
    ).rejects.toThrow('injected create interruption');

    refreshCanvasDirIndex();
    expect(existsSync(path.join(workspace, 'Create Failure'))).toBe(false);
    expect(existsSync(canvasJsonPath('create-failure'))).toBe(false);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('restores a quarantined Space when delete has not committed', async () => {
    const seeded = await new DiskSpaceLifecycleRepository().create({
      canvasId: 'delete-failure',
      title: 'Delete Failure',
    });
    expect(seeded.ok).toBe(true);

    const journal = realJournal();
    const lifecycle = new DiskSpaceLifecycleRepository({
      ...journal,
      apply(transaction): void {
        journal.apply(transaction);
        throw new Error('injected delete interruption');
      },
    });

    await expect(
      lifecycle.delete({ canvasId: 'delete-failure' }),
    ).rejects.toThrow('injected delete interruption');

    refreshCanvasDirIndex();
    expect(existsSync(canvasJsonPath('delete-failure'))).toBe(true);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('returns successful creates after committed cleanup fails and admits the next create', async () => {
    const journal = realJournal();
    const lifecycle = new DiskSpaceLifecycleRepository(
      {
        ...journal,
        finalize(): void {
          throw new Error('injected create cleanup failure');
        },
      },
      () => 42,
    );

    await expect(
      lifecycle.create({ canvasId: 'create-first', title: 'Create First' }),
    ).resolves.toMatchObject({ ok: true, record: { version: 0 } });
    expect(existsSync(canvasJsonPath('create-first'))).toBe(true);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);

    await expect(
      lifecycle.create({ canvasId: 'create-second', title: 'Create Second' }),
    ).resolves.toMatchObject({ ok: true, record: { version: 0 } });
    expect(existsSync(canvasJsonPath('create-second'))).toBe(true);
  });

  it('returns successful deletes after committed cleanup fails and admits the next delete', async () => {
    const seed = new DiskSpaceLifecycleRepository();
    await expect(
      seed.create({ canvasId: 'delete-first', title: 'Delete First' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      seed.create({ canvasId: 'delete-second', title: 'Delete Second' }),
    ).resolves.toMatchObject({ ok: true });

    const journal = realJournal();
    const lifecycle = new DiskSpaceLifecycleRepository({
      ...journal,
      finalize(): void {
        throw new Error('injected delete cleanup failure');
      },
    });

    await expect(
      lifecycle.delete({ canvasId: 'delete-first' }),
    ).resolves.toEqual({ ok: true, reason: 'deleted' });
    expect(existsSync(canvasJsonPath('delete-first'))).toBe(false);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);

    await expect(
      lifecycle.delete({ canvasId: 'delete-second' }),
    ).resolves.toEqual({ ok: true, reason: 'deleted' });
    expect(existsSync(canvasJsonPath('delete-second'))).toBe(false);
  });

  it('treats post-marker tombstone cleanup as best effort and admits a successor', async () => {
    await expect(
      new DiskSpaceLifecycleRepository().create({
        canvasId: 'delete-metadata-failure',
        title: 'Delete Metadata Failure',
      }),
    ).resolves.toMatchObject({ ok: true });

    let cleanupAttempts = 0;
    const lifecycle = new DiskSpaceLifecycleRepository(
      realJournal(),
      Date.now,
      () => {
        cleanupAttempts += 1;
        throw new Error('injected tombstone cleanup failure');
      },
    );
    await expect(
      lifecycle.delete({ canvasId: 'delete-metadata-failure' }),
    ).resolves.toEqual({ ok: true, reason: 'deleted' });
    expect(cleanupAttempts).toBe(1);
    expect(existsSync(canvasJsonPath('delete-metadata-failure'))).toBe(false);

    await expect(
      lifecycle.create({
        canvasId: 'delete-metadata-failure',
        title: 'Recreated After Cleanup Failure',
      }),
    ).resolves.toMatchObject({ ok: true, record: { version: 0 } });
    expect(existsSync(canvasJsonPath('delete-metadata-failure'))).toBe(true);
  });
});
