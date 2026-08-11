// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

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
import { nodesDir, tasksPath } from '../../../workspace/disk/paths.js';
import { describeCanvasLogRepositoriesContract } from '../../ports/contracts/canvas-log-repository.contract.js';
import { describeNodeRepositoryContract } from '../../ports/contracts/node-repository.contract.js';
import { describeSpaceCommitContract } from '../../ports/contracts/space-commit.contract.js';
import { describeSpaceLifecycleContract } from '../../ports/contracts/space-lifecycle.contract.js';
import { describeSpaceRepositoryContract } from '../../ports/contracts/space-repository.contract.js';
import { describeStructuredStoreContract } from '../../ports/contracts/structured-store.contract.js';

import type {
  CanvasFile,
  NodeContent,
} from '../../../canvas/persistence-types.js';

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

function seedWorld(root: string): CanvasFile {
  const dir = path.join(root, '.world');
  mkdirSync(dir, { recursive: true });
  const record: CanvasFile = {
    canvasId: 'canvas-world',
    title: 'World',
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

describeSpaceLifecycleContract('DiskSpaceLifecycleRepository', () => {
  const root = freshWorkspace('huabu-space-lifecycle-');
  seedWorld(root);
  const store = new DiskStructuredStore();
  return {
    lifecycle: store.lifecycle(),
    read: (canvasId: string) => store.space(canvasId).record.read(),
    worldCanvasId: 'canvas-world',
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describeSpaceRepositoryContract('DiskSpaceRepository', () => {
  const root = freshWorkspace('huabu-space-repo-');
  const expected = seedSpace(root, 'canvas-a', 'Canvas A');
  const store = new DiskStructuredStore();
  return {
    repository: store.space('canvas-a').record,
    expected,
    missing: store.space('no-such-canvas').record,
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describeNodeRepositoryContract('DiskNodeRepository', () => {
  const root = freshWorkspace('huabu-node-repo-');
  seedSpace(root, 'canvas-a', 'Canvas A');
  const record: NodeContent = {
    nodeId: 'node-a',
    type: 'note',
    label: 'Meeting notes',
    content: 'Canonical body',
    summary: 'Initial summary',
    attributes: { priority: 2, tags: ['portable', 'async'] },
  };
  const legacy = getCanvasStore('canvas-a');
  const seeded = legacy.writeNode(record.nodeId, record);
  if (!seeded.ok) throw new Error(`Could not seed node: ${seeded.reason}`);

  const structured = new DiskStructuredStore();
  return {
    repository: structured.space('canvas-a').nodes,
    existing: { record, logicalName: seeded.filename },
    missingNodeId: 'node-missing',
    replaceExisting: (next: NodeContent) => {
      const result = legacy.writeNode(next.nodeId, next);
      if (!result.ok) {
        throw new Error(`Could not replace node: ${result.reason}`);
      }
    },
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describeSpaceCommitContract('DiskSpaceCommitter', () => {
  const root = freshWorkspace('huabu-space-commit-');
  // The id deliberately resembles a conventional World id while remaining
  // an ordinary Space. World policy is identity-based, never prefix-based.
  const canvasId = 'canvas-world-contract-ordinary';
  const seeded = seedSpace(root, canvasId, 'Canvas A');
  const existingNode: NodeContent = {
    nodeId: 'node-existing',
    type: 'note',
    label: 'Existing node',
    content: 'Existing body',
    summary: 'Existing summary',
  };
  const newNode: NodeContent = {
    nodeId: 'node-new',
    type: 'note',
    label: 'New node',
    content: 'New body',
  };
  const legacy = getCanvasStore(canvasId);
  legacy.write({
    ...seeded,
    state: {
      nodes: [
        {
          id: existingNode.nodeId,
          type: existingNode.type,
          data: { label: existingNode.label },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
  });
  const nodeWrite = legacy.writeNode(existingNode.nodeId, existingNode);
  if (!nodeWrite.ok) {
    throw new Error(`Could not seed commit node: ${nodeWrite.reason}`);
  }

  const structured = new DiskStructuredStore();
  return {
    handle: structured.space(canvasId),
    concurrent: structured.space(canvasId),
    missing: structured.space('missing-canvas'),
    existingNode,
    newNode,
    replaceExistingNodeOutOfBand: (record: NodeContent) => {
      const result = legacy.writeNode(record.nodeId, record);
      if (!result.ok) {
        throw new Error(`Could not replace commit node: ${result.reason}`);
      }
    },
    failNextPublicationAfterAppend: (error: Error) => {
      const original = legacy.appendDeltaLogEntry;
      legacy.appendDeltaLogEntry = (entry) => {
        original.call(legacy, entry);
        throw error;
      };
      return () => {
        legacy.appendDeltaLogEntry = original;
      };
    },
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describe('Disk node snapshot details', () => {
  let root = '';

  afterEach(() => {
    resetStorageCache();
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('tracks an external logical rename without exposing a path', async () => {
    root = freshWorkspace('huabu-node-logical-name-');
    seedSpace(root, 'canvas-a', 'Canvas A');
    const legacy = getCanvasStore('canvas-a');
    const record: NodeContent = {
      nodeId: 'node-a',
      type: 'note',
      label: 'Original name',
      content: 'Body',
    };
    const written = legacy.writeNode(record.nodeId, record);
    if (!written.ok) throw new Error(`Could not seed node: ${written.reason}`);

    const before = await new DiskStructuredStore()
      .space('canvas-a')
      .nodes.read(record.nodeId);
    const renamed = 'External name.md';
    renameSync(
      path.join(nodesDir('canvas-a'), written.filename),
      path.join(nodesDir('canvas-a'), renamed),
    );

    // A fresh Disk handle models a process restart / cold adapter and observes
    // the sidecar name as logical metadata, never as a physical locator.
    resetStorageCache();
    const after = await new DiskStructuredStore()
      .space('canvas-a')
      .nodes.read(record.nodeId);

    if (after === null) throw new Error('Renamed node was not readable');
    expect(after.logicalName).toBe(renamed);
    expect(after.logicalName).toBe(path.basename(after.logicalName));
    expect(after.logicalName).not.toContain(root);
    expect(after.revision).not.toBe(before?.revision);
  });

  it('reports every logical name when sidecars duplicate a node id', async () => {
    root = freshWorkspace('huabu-node-duplicates-');
    seedSpace(root, 'canvas-a', 'Canvas A');
    const legacy = getCanvasStore('canvas-a');
    const record: NodeContent = {
      nodeId: 'node-a',
      type: 'note',
      label: 'First',
      content: 'Body',
    };
    const written = legacy.writeNode(record.nodeId, record);
    if (!written.ok) throw new Error(`Could not seed node: ${written.reason}`);
    copyFileSync(
      path.join(nodesDir('canvas-a'), written.filename),
      path.join(nodesDir('canvas-a'), 'Second.md'),
    );

    resetStorageCache();
    const snapshot = await new DiskStructuredStore()
      .space('canvas-a')
      .nodes.read(record.nodeId);

    expect(snapshot?.duplicateLogicalNames).toEqual(['First.md', 'Second.md']);
    expect(snapshot?.duplicateLogicalNames).toContain(snapshot?.logicalName);
  });

  it('rejects a commit when the durable Space record is malformed', async () => {
    root = freshWorkspace('huabu-commit-invalid-record-');
    seedSpace(root, 'canvas-a', 'Canvas A');
    writeFileSync(path.join(root, 'Canvas A', 'space.json'), '{}', 'utf8');

    await expect(
      new DiskStructuredStore().space('canvas-a').commit({
        expectedVersion: 0,
        record: { title: 'Canvas A', state: { nodes: [], edges: [] } },
        nodePreconditions: [],
        nodeMutations: [],
        publication: {
          originator: { source: 'system' },
          optimistic: false,
          commands: [],
          structureDeltas: [],
        },
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});

describeCanvasLogRepositoriesContract('Disk log-family repositories', () => {
  const root = freshWorkspace('huabu-log-repo-');
  seedSpace(root, 'canvas-a', 'Canvas A');
  const store = new DiskStructuredStore();
  const handle = store.space('canvas-a');
  const concurrent = store.space('canvas-a');
  const legacy = getCanvasStore('canvas-a');
  return {
    events: handle.events,
    deltas: handle.deltas,
    changes: handle.changes,
    intents: handle.intents,
    concurrent: {
      events: concurrent.events,
      deltas: concurrent.deltas,
      changes: concurrent.changes,
      intents: concurrent.intents,
    },
    seedDeltas: (entries) => {
      for (const entry of entries) legacy.appendDeltaLogEntry(entry);
    },
    cleanup: () => {
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describe('Disk Canvas Task repository', () => {
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
      first.insertTask({
        taskId: 'task-a',
        canvasId: 'canvas-task',
        goal: 'Goal A',
        defaultRootProfileId: 'profile-a',
        anchorNodeId: 'node-a',
        createdAt: 1,
      }),
      second.insertTask({
        taskId: 'task-b',
        canvasId: 'canvas-task',
        goal: 'Goal B',
        defaultRootProfileId: 'profile-b',
        anchorNodeId: 'node-b',
        createdAt: 2,
      }),
    ]);
    await first.insertRun({
      runId: 'run-a',
      taskId: 'task-a',
      canvasIdSnapshot: 'canvas-task',
      goalSnapshot: 'Goal A',
      rootProfileIdSnapshot: 'profile-a',
      status: 'pending',
      createdAt: 3,
    });
    const updated = await second.updateRun('run-a', {
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

  it('rejects mutations for a missing Space', async () => {
    await expect(
      store.space('missing-canvas').tasks.insertTask({
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

describe('Disk Workspace transaction serialization', () => {
  let root = '';

  beforeAll(() => {
    root = freshWorkspace('huabu-workspace-transactions-');
    seedSpace(root, 'canvas-first', 'First');
    seedSpace(root, 'canvas-second', 'Second');
  });

  afterAll(() => {
    resetStorageCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('serializes journal windows for concurrent commits to different Spaces', async () => {
    const store = new DiskStructuredStore();
    const first = store.space('canvas-first');
    const second = store.space('canvas-second');
    const firstRecord = await first.record.read();
    const secondRecord = await second.record.read();
    if (!firstRecord || !secondRecord) throw new Error('fixture missing');

    const publication = {
      originator: { source: 'system' as const },
      optimistic: false,
      commands: [],
      structureDeltas: [],
    };
    const results = await Promise.all([
      first.commit({
        expectedVersion: firstRecord.version,
        record: { title: 'First renamed', state: firstRecord.state },
        nodePreconditions: [],
        nodeMutations: [],
        publication,
      }),
      second.commit({
        expectedVersion: secondRecord.version,
        record: { title: 'Second renamed', state: secondRecord.state },
        nodePreconditions: [],
        nodeMutations: [],
        publication,
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: true, committed: true }),
      expect.objectContaining({ ok: true, committed: true }),
    ]);
    await expect(first.record.read()).resolves.toMatchObject({
      title: 'First renamed',
      version: 1,
    });
    await expect(second.record.read()).resolves.toMatchObject({
      title: 'Second renamed',
      version: 1,
    });
  });

  it('publishes a Finder title when the next node commit makes it durable', async () => {
    const canvasId = 'canvas-finder-commit';
    seedSpace(root, canvasId, 'Original title');
    const legacy = getCanvasStore(canvasId);
    const original = legacy.read();
    if (!original) throw new Error('fixture missing');
    legacy.write({
      ...original,
      state: {
        nodes: [
          {
            id: 'node-a',
            type: 'note',
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      },
    });
    const seeded = legacy.writeNode('node-a', {
      nodeId: 'node-a',
      type: 'note',
      label: 'A',
      content: 'before',
    });
    if (!seeded.ok) throw new Error(`node seed failed: ${seeded.reason}`);

    const movedRoot = path.join(root, 'Finder title');
    renameSync(path.join(root, 'Original title'), movedRoot);
    refreshCanvasDirIndex();
    const handle = new DiskStructuredStore().space(canvasId);
    const current = await handle.record.read();
    const node = await handle.nodes.read('node-a');
    if (!current || !node) throw new Error('renamed fixture missing');

    const result = await handle.commit({
      expectedVersion: current.version,
      record: { title: current.title, state: current.state },
      nodePreconditions: [{ nodeId: 'node-a', revision: node.revision }],
      nodeMutations: [
        {
          kind: 'put',
          record: { ...node.record, content: 'after' },
        },
      ],
      publication: {
        originator: { source: 'system' },
        optimistic: false,
        commands: [],
        structureDeltas: [],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      committed: true,
      event: { title: 'Finder title' },
    });
    expect(
      JSON.parse(readFileSync(path.join(movedRoot, 'space.json'), 'utf8')),
    ).toMatchObject({ title: 'Finder title', version: 1 });
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

  it('exposes four frozen, runtime-narrow log-family repositories', () => {
    const handle = new DiskStructuredStore().space('canvas-c');
    const runtime = handle as unknown as Record<string, unknown>;

    expect(runtime['logs']).toBeUndefined();
    expect(Object.keys(handle.events)).toEqual(['append', 'read']);
    expect(Object.keys(handle.deltas)).toEqual(['readSince']);
    expect(Object.keys(handle.changes)).toEqual(['read', 'append', 'remove']);
    expect(Object.keys(handle.intents)).toEqual(['read', 'upsert']);

    for (const repository of [
      handle.events,
      handle.deltas,
      handle.changes,
      handle.intents,
    ]) {
      expect(Object.isFrozen(repository)).toBe(true);
      expect('store' in repository).toBe(false);
    }
  });
});
