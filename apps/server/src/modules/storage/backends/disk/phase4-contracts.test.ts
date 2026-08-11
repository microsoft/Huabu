// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { DiskStructuredStore } from './structured-store.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { ensureWorldCanvasOnDisk } from '../../../workspace/disk/world-canvas.js';
import { setWorkspacePath } from '../../../workspace.js';
import { describeNodeRepositoryContract } from '../../ports/contracts/node-repository.contract.js';
import { describeOrderedSpaceWriterContract } from '../../ports/contracts/ordered-space-writer.contract.js';
import { describeSpaceLifecycleContract } from '../../ports/contracts/space-lifecycle.contract.js';

import type { NodeContent } from '../../../canvas/persistence-types.js';

function freshDiskStore(prefix: string): {
  root: string;
  store: DiskStructuredStore;
  worldCanvasId: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  setWorkspacePath(root);
  resetStorageCache();
  const worldCanvasId = ensureWorldCanvasOnDisk(root);
  refreshCanvasDirIndex();
  return {
    root,
    store: new DiskStructuredStore(),
    worldCanvasId,
    cleanup: () => {
      vi.restoreAllMocks();
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function note(nodeId: string, label: string, content: string): NodeContent {
  return { nodeId, type: 'note', label, content };
}

describeSpaceLifecycleContract('Disk', () => {
  const fixture = freshDiskStore('huabu-lifecycle-contract-');
  return {
    lifecycle: fixture.store.lifecycle(),
    read: (canvasId: string) => fixture.store.space(canvasId).record.read(),
    worldCanvasId: fixture.worldCanvasId,
    cleanup: fixture.cleanup,
  };
});

describeNodeRepositoryContract('Disk', async () => {
  const fixture = freshDiskStore('huabu-node-contract-');
  const created = await fixture.store.lifecycle().create({
    canvasId: 'node-space',
    title: 'Node contract Space',
  });
  if (!created.ok) throw new Error('Node contract Space already exists');
  return {
    repository: fixture.store.space('node-space').nodes,
    missingRepository: fixture.store.space('missing-node-space').nodes,
    expectedCanvasId: 'node-space',
    cleanup: fixture.cleanup,
  };
});

describeOrderedSpaceWriterContract('Disk', async () => {
  const fixture = freshDiskStore('huabu-writer-contract-');
  const created = await fixture.store.lifecycle().create({
    canvasId: 'writer-space',
    title: 'Writer contract Space',
  });
  if (!created.ok) throw new Error('Writer contract Space already exists');

  const existingNode = note(
    'contract-existing-node',
    'Existing contract node',
    'before',
  );
  const firstHandle = fixture.store.space('writer-space');
  const put = await firstHandle.nodes.put({
    nodeId: existingNode.nodeId,
    record: existingNode,
  });
  if (!put.ok) throw new Error(`Could not seed writer contract: ${put.reason}`);

  return {
    space: {
      writer: firstHandle.writer,
      record: firstHandle.record,
      nodes: firstHandle.nodes,
      deltas: firstHandle.deltas,
    },
    concurrent: fixture.store.space('writer-space').writer,
    missing: (() => {
      const handle = fixture.store.space('missing-writer-space');
      return {
        writer: handle.writer,
        record: handle.record,
        nodes: handle.nodes,
        deltas: handle.deltas,
      };
    })(),
    existingNode,
    newNode: note('contract-new-node', 'New contract node', 'after'),
    failNextDeltaAppend: (error: Error) => {
      const spy = vi
        .spyOn(getCanvasStore('writer-space'), 'appendDeltaLogEntry')
        .mockImplementationOnce(() => {
          throw error;
        });
      return () => spy.mockRestore();
    },
    cleanup: fixture.cleanup,
  };
});
