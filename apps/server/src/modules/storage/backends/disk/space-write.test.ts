// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { createDiskDeltaLog } from './space-logs.js';
import { DiskSpaceRepository } from './space-repository.js';
import { createDiskSpaceWrite } from './space-write.js';
import { DiskStructuredStore } from './structured-store.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { nodesDir } from '../../../workspace/disk/paths.js';
import { ensureWorldCanvasOnDisk } from '../../../workspace/disk/world-canvas.js';
import { setWorkspacePath } from '../../../workspace.js';
import { describeSpaceWriteContract } from '../../ports/contracts/space-write.contract.js';

import type {
  CanvasFile,
  NodeContent,
} from '../../../canvas/persistence-types.js';

function freshWorkspace(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  setWorkspacePath(root);
  resetStorageCache();
  ensureWorldCanvasOnDisk(root);
  refreshCanvasDirIndex();
  return root;
}

function note(nodeId: string, label: string, content: string): NodeContent {
  return { nodeId, type: 'note', label, content };
}

describeSpaceWriteContract('Disk', async () => {
  const root = freshWorkspace('huabu-writer-contract-');
  const store = new DiskStructuredStore();
  const created = await store.spaces().create({
    canvasId: 'writer-space',
    title: 'Writer contract Space',
  });
  if (!created.ok) throw new Error('Writer contract Space already exists');

  const existingNode = note(
    'contract-existing-node',
    'Existing contract node',
    'before',
  );
  const firstHandle = store.space('writer-space');
  const put = await firstHandle.nodes.put({
    nodeId: existingNode.nodeId,
    record: existingNode,
  });
  if (!put.ok) throw new Error(`Could not seed writer contract: ${put.reason}`);

  return {
    space: firstHandle,
    concurrent: store.space('writer-space'),
    missing: store.space('missing-writer-space'),
    existingNode,
    newNode: note('contract-new-node', 'New contract node', 'after'),
    readJournal: () =>
      createDiskDeltaLog(getCanvasStore('writer-space')).readSince(0),
    failNextDeltaAppend: (error: Error) => {
      const spy = vi
        .spyOn(getCanvasStore('writer-space'), 'appendDeltaLogEntry')
        .mockImplementationOnce(() => {
          throw error;
        });
      return () => spy.mockRestore();
    },
    cleanup: () => {
      vi.restoreAllMocks();
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describe('Disk ordered Space write', () => {
  let workspacePath: string;
  let before: CanvasFile;

  beforeEach(async () => {
    workspacePath = freshWorkspace('huabu-ordered-writer-');
    const created = await new DiskSpaceRepository(() => 1).create({
      canvasId: 'canvas-a',
      title: 'Shared title',
    });
    if (!created.ok) throw new Error('test Space already exists');
    before = created.record;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetStorageCache();
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('refuses a batch delete when duplicate sidecars claim the node id', async () => {
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    for (const filename of ['Node A.md', 'Duplicate A.md']) {
      writeFileSync(
        path.join(nodesDir('canvas-a'), filename),
        `---\nid: node-a\ntype: note\nlabel: ${filename.replace(/\.md$/, '')}\n---\nbody\n`,
        'utf8',
      );
    }
    const store = getCanvasStore('canvas-a');
    const write = createDiskSpaceWrite(store);

    await expect(
      write({
        expectedVersion: 0,
        nextRecord: { ...before, version: 1, updatedAt: 2 },
        nodeMutations: [{ kind: 'delete', nodeId: 'node-a' }],
        delta: {
          version: 1,
          ts: 2,
          commands: [],
          deltas: [],
          originator: { source: 'ui' },
        },
      }),
    ).rejects.toThrow(/multiple sidecars claim that id/);
    expect(store.read()).toEqual(before);
    expect(readdirSync(nodesDir('canvas-a')).sort()).toEqual([
      'Duplicate A.md',
      'Node A.md',
    ]);
    expect(store.readDeltaLogSince(0)).toEqual([]);
  });

  it('rolls node and record writes back when the final delta append fails', async () => {
    const store = getCanvasStore('canvas-a');
    const write = createDiskSpaceWrite(store);
    const failure = new Error('delta append failed');
    vi.spyOn(store, 'appendDeltaLogEntry').mockImplementationOnce(() => {
      throw failure;
    });

    const next: CanvasFile = {
      ...before,
      version: 1,
      state: {
        nodes: [{ id: 'node-a', type: 'note' }],
        edges: [],
      },
      updatedAt: 2,
    };
    await expect(
      write({
        expectedVersion: 0,
        nextRecord: next,
        nodeMutations: [
          {
            kind: 'put',
            nodeId: 'node-a',
            record: note('node-a', 'Node A', 'body'),
            authoritativeInsert: true,
          },
        ],
        delta: {
          version: 1,
          ts: 2,
          commands: [],
          deltas: [],
          originator: { source: 'ui' },
        },
      }),
    ).rejects.toBe(failure);

    expect(store.read()).toEqual(before);
    expect(store.readNode('node-a')).toBeNull();
    expect(store.readDeltaLogSince(0)).toEqual([]);
  });
});
