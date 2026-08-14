// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { tasksPath } from './layout.js';
import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { DiskStructuredStore } from './structured-store.js';
import { toSafeFilename } from '../../../../utils/naming.js';
import { describeSpaceLogsContract } from '../../ports/contracts/space-logs.contract.js';
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

describeSpaceLogsContract('Disk Space logs', () => {
  const root = freshWorkspace('huabu-log-repo-');
  seedSpace(root, 'canvas-a', 'Canvas A');
  const store = new DiskStructuredStore();
  const handle = store.space('canvas-a');
  const concurrent = store.space('canvas-a');
  return {
    events: handle.events,
    changes: handle.changes,
    concurrent: {
      events: concurrent.events,
      changes: concurrent.changes,
    },
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describe('Disk Space Tasks', () => {
  let root = '';
  let store: DiskStructuredStore;

  beforeAll(() => {
    root = freshWorkspace('huabu-task-repo-');
    seedSpace(root, 'canvas-task', 'Canvas Task');
    seedSpace(root, 'canvas-empty', 'Canvas Empty');
    store = new DiskStructuredStore();
  });

  afterAll(() => {
    resetStorageCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('serializes Task and Run mutations across independent handles', async () => {
    const first = store.space('canvas-task').tasks;
    const second = store.space('canvas-task').tasks;
    await Promise.all([
      first.create({
        taskId: 'task-a',
        canvasId: 'canvas-task',
        goal: 'Goal A',
        defaultRootProfileId: 'profile-a',
        anchorNodeId: 'node-a',
        createdAt: 1,
      }),
      second.create({
        taskId: 'task-b',
        canvasId: 'canvas-task',
        goal: 'Goal B',
        defaultRootProfileId: 'profile-b',
        anchorNodeId: 'node-b',
        createdAt: 2,
      }),
    ]);
    await first.runs.create({
      runId: 'run-a',
      taskId: 'task-a',
      canvasIdSnapshot: 'canvas-task',
      goalSnapshot: 'Goal A',
      rootProfileIdSnapshot: 'profile-a',
      status: 'pending',
      createdAt: 3,
    });
    const updated = await second.runs.update('run-a', {
      rootNodeId: 'node-root',
      rootThreadId: 'thread-root',
      status: 'running',
      startedAt: 4,
    });

    expect(updated.status).toBe('running');
    await expect(first.read()).resolves.toMatchObject({
      version: 1,
      tasks: [
        expect.objectContaining({ taskId: 'task-a' }),
        expect.objectContaining({ taskId: 'task-b' }),
      ],
      runs: [
        expect.objectContaining({
          runId: 'run-a',
          rootNodeId: 'node-root',
          rootThreadId: 'thread-root',
        }),
      ],
    });
  });

  it('returns an empty versioned snapshot when no Task store exists', async () => {
    await expect(store.space('canvas-empty').tasks.read()).resolves.toEqual({
      version: 1,
      tasks: [],
      runs: [],
    });
  });

  it('completes a running Run atomically and keeps its message immutable', async () => {
    const runs = store.space('canvas-task').tasks.runs;
    await expect(
      runs.complete('task-a', 'run-a', {
        completedAt: 5,
        message: 'PR merged',
      }),
    ).resolves.toMatchObject({
      outcome: 'completed',
      run: {
        status: 'completed',
        completion: { completedAt: 5, message: 'PR merged' },
      },
    });
    await expect(
      runs.complete('task-a', 'run-a', {
        completedAt: 6,
        message: 'PR merged',
      }),
    ).resolves.toMatchObject({
      outcome: 'unchanged',
      run: { completion: { completedAt: 5, message: 'PR merged' } },
    });
    await expect(
      runs.complete('task-a', 'run-a', {
        completedAt: 7,
        message: 'Different result',
      }),
    ).resolves.toMatchObject({ outcome: 'completion_conflict' });

    await runs.create({
      runId: 'run-pending',
      taskId: 'task-b',
      canvasIdSnapshot: 'canvas-task',
      goalSnapshot: 'Goal B',
      rootProfileIdSnapshot: 'profile-b',
      status: 'pending',
      createdAt: 8,
    });
    await expect(
      runs.complete('task-b', 'run-pending', { completedAt: 9 }),
    ).resolves.toMatchObject({ outcome: 'run_not_running' });
    await expect(
      runs.complete('missing-task', 'run-a', { completedAt: 9 }),
    ).resolves.toEqual({ outcome: 'task_not_found' });
    await expect(
      runs.complete('task-a', 'missing-run', { completedAt: 9 }),
    ).resolves.toEqual({ outcome: 'run_not_found' });
  });

  it('rejects mutations for a missing Space', async () => {
    await expect(
      store.space('missing-canvas').tasks.create({
        taskId: 'task-missing',
        canvasId: 'missing-canvas',
        goal: 'Missing',
        defaultRootProfileId: 'profile-a',
        anchorNodeId: 'node-missing',
        createdAt: 1,
      }),
    ).rejects.toThrow(/cannot write a missing Space/);
  });

  it('fails fast on malformed and internally inconsistent Task stores', async () => {
    writeFileSync(tasksPath('canvas-task'), '{"version":1,"tasks":{}}');
    await expect(store.space('canvas-task').tasks.read()).rejects.toThrow(
      /Invalid Task store/,
    );

    writeFileSync(
      tasksPath('canvas-task'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            taskId: 'task-duplicate',
            canvasId: 'canvas-task',
            goal: 'Goal',
            defaultRootProfileId: 'profile-a',
            anchorNodeId: 'node-a',
            createdAt: 1,
          },
          {
            taskId: 'task-duplicate',
            canvasId: 'canvas-task',
            goal: 'Goal',
            defaultRootProfileId: 'profile-a',
            anchorNodeId: 'node-b',
            createdAt: 2,
          },
        ],
        runs: [],
      }),
    );
    await expect(store.space('canvas-task').tasks.read()).rejects.toThrow(
      /duplicate Task/,
    );

    writeFileSync(
      tasksPath('canvas-task'),
      JSON.stringify({
        version: 1,
        tasks: [],
        runs: [
          {
            runId: 'run-orphan',
            taskId: 'task-missing',
            canvasIdSnapshot: 'canvas-task',
            goalSnapshot: 'Goal',
            rootProfileIdSnapshot: 'profile-a',
            status: 'pending',
            createdAt: 1,
          },
        ],
      }),
    );
    await expect(store.space('canvas-task').tasks.read()).rejects.toThrow(
      /references missing Task/,
    );
  });

  it('rejects a retained handle after the active Workspace changes', async () => {
    const retained = store.space('canvas-empty').tasks;
    const replacement = freshWorkspace('huabu-task-repo-next-');

    await expect(retained.read()).rejects.toThrow(/inactive workspace/);

    workspaceState.path = root;
    resetStorageCache();
    rmSync(replacement, { recursive: true, force: true });
  });
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

  it('exposes frozen, runtime-narrow log-backed parts', () => {
    const handle = new DiskStructuredStore().space('canvas-c');
    const runtime = handle as unknown as Record<string, unknown>;

    expect(runtime['logs']).toBeUndefined();
    expect(Object.keys(handle.events)).toEqual(['read', 'append']);
    expect(Object.keys(handle.changes)).toEqual(['read', 'append', 'delete']);
    expect(Object.keys(handle.tasks.runs)).toEqual([
      'create',
      'update',
      'complete',
    ]);

    for (const part of [handle.events, handle.changes, handle.tasks.runs]) {
      expect(Object.isFrozen(part)).toBe(true);
      expect('store' in part).toBe(false);
    }
  });
});
