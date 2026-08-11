// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { DiskNodeRepository } from './node-repository.js';
import { DiskOrderedSpaceWriter } from './ordered-space-writer.js';
import { DiskSpaceLifecycleRepository } from './space-lifecycle.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { nodesDir } from '../../../workspace/disk/paths.js';
import { setWorkspacePath } from '../../../workspace.js';

import type {
  CanvasFile,
  NodeContent,
} from '../../../canvas/persistence-types.js';

let workspacePath: string;

beforeEach(() => {
  workspacePath = mkdtempSync(path.join(tmpdir(), 'huabu-phase4-adapters-'));
  setWorkspacePath(workspacePath);
  resetStorageCache();
  refreshCanvasDirIndex();
});

afterEach(() => {
  resetStorageCache();
  rmSync(workspacePath, { recursive: true, force: true });
});

async function createSpace(canvasId = 'canvas-a'): Promise<CanvasFile> {
  const result = await new DiskSpaceLifecycleRepository(() => 1).create({
    canvasId,
    title: 'Shared title',
  });
  if (!result.ok) throw new Error('test Space already exists');
  return result.record;
}

function note(nodeId: string, label: string, content: string): NodeContent {
  return { nodeId, type: 'note', label, content };
}

describe('minimal Phase-4 Disk adapters', () => {
  it('persists the de-duplicated title and reports explicit delete outcomes', async () => {
    const lifecycle = new DiskSpaceLifecycleRepository(() => 1);
    const first = await lifecycle.create({
      canvasId: 'canvas-a',
      title: 'Shared title',
    });
    const second = await lifecycle.create({
      canvasId: 'canvas-b',
      title: 'Shared title',
    });

    expect(first).toMatchObject({
      ok: true,
      record: { title: 'Shared title' },
    });
    expect(second).toMatchObject({
      ok: true,
      record: { title: 'Shared title (2)' },
    });
    await expect(lifecycle.delete({ canvasId: 'canvas-b' })).resolves.toEqual({
      ok: true,
      reason: 'deleted',
    });
    await expect(lifecycle.delete({ canvasId: 'canvas-b' })).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('uses full-record node CAS and returns the exact persisted record', async () => {
    await createSpace();
    const repository = new DiskNodeRepository(getCanvasStore('canvas-a'));
    const first = await repository.put({
      nodeId: 'node-a',
      record: note('node-a', 'Shared', 'before'),
    });
    expect(first).toMatchObject({ ok: true, record: { label: 'Shared' } });
    if (!first.ok) throw new Error('first node write failed');

    const renamed = await repository.put({
      nodeId: 'node-a',
      expectedRevision: first.revision,
      record: note('node-a', 'Renamed', 'before'),
    });
    expect(renamed).toMatchObject({
      ok: true,
      record: { label: 'Renamed' },
    });
    if (!renamed.ok) throw new Error('node rename failed');
    expect(renamed.revision).not.toBe(first.revision);

    // The adapter must report the exact record CanvasStore persisted after
    // non-strict name de-duplication, not echo the caller's input object.
    await expect(
      repository.put({
        nodeId: 'node-b',
        record: note('node-b', 'Renamed', 'second'),
      }),
    ).resolves.toMatchObject({
      ok: true,
      record: { label: 'Renamed (2)' },
    });

    await expect(
      repository.put({
        nodeId: 'node-a',
        expectedRevision: 'stale',
        record: note('node-a', 'Renamed', 'after'),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'revision-conflict',
      currentRevision: renamed.revision,
    });

    await repository.delete('node-a');
    await expect(
      repository.put({
        nodeId: 'node-a',
        record: note('node-a', 'Renamed', 'late'),
      }),
    ).resolves.toEqual({ ok: false, reason: 'write-suppressed' });
  });

  it('rejects malformed durable node state instead of reporting absence', async () => {
    await createSpace();
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    writeFileSync(
      path.join(nodesDir('canvas-a'), 'broken.md'),
      '---\nid: broken\nkeywords: [\n---\nbody',
      'utf8',
    );
    const repository = new DiskNodeRepository(getCanvasStore('canvas-a'));

    await expect(repository.read('broken')).rejects.toThrow();
  });

  it('rolls node and record writes back when the final delta append fails', async () => {
    const before = await createSpace();
    const store = getCanvasStore('canvas-a');
    const writer = new DiskOrderedSpaceWriter(store);
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
      writer.apply({
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
