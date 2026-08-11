// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { DiskNodeRepository } from './node-repository.js';
import { DiskOrderedSpaceWriter } from './ordered-space-writer.js';
import { DiskSpaceCatalogRepository } from './space-catalog-repository.js';
import { DiskSpaceLifecycleRepository } from './space-lifecycle.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { nodesDir } from '../../../workspace/disk/paths.js';
import { ensureWorldCanvasOnDisk } from '../../../workspace/disk/world-canvas.js';
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
  ensureWorldCanvasOnDisk(workspacePath);
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
    const deletion = await lifecycle.beginDelete({ canvasId: 'canvas-b' });
    if (!deletion.ok) throw new Error('ordinary Space must be deletable');
    await expect(deletion.session.finish()).resolves.toEqual({
      ok: true,
      reason: 'deleted',
    });
    const missing = await lifecycle.beginDelete({ canvasId: 'canvas-b' });
    if (!missing.ok) throw new Error('missing Space must be cleanable');
    await expect(missing.session.finish()).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refreshes membership before allocating around an externally imported Space', async () => {
    const lifecycle = new DiskSpaceLifecycleRepository(() => 1);
    await lifecycle.create({ canvasId: 'warm-index', title: 'Warm index' });
    const importedRoot = path.join(workspacePath, 'Taken');
    mkdirSync(importedRoot, { recursive: true });
    const imported = {
      canvasId: 'external-space',
      title: 'Taken',
      version: 7,
      state: { nodes: [], edges: [] },
      createdAt: 2,
      updatedAt: 3,
    };
    writeFileSync(
      path.join(importedRoot, 'space.json'),
      JSON.stringify(imported),
      'utf8',
    );

    const created = await lifecycle.create({
      canvasId: 'new-space',
      title: 'Taken',
    });

    expect(created).toMatchObject({
      ok: true,
      record: { canvasId: 'new-space', title: 'Taken (2)' },
    });
    expect(
      JSON.parse(readFileSync(path.join(importedRoot, 'space.json'), 'utf8')),
    ).toEqual(imported);
  });

  it('keeps an allocated null title consistent in the record and catalogue', async () => {
    const lifecycle = new DiskSpaceLifecycleRepository(() => 1);
    await lifecycle.create({
      canvasId: 'physical-name-owner',
      title: 'null-title-space',
    });
    const created = await lifecycle.create({
      canvasId: 'null-title-space',
      title: null,
    });

    expect(created).toMatchObject({ ok: true, record: { title: null } });
    await expect(
      new DiskSpaceCatalogRepository().list(),
    ).resolves.toContainEqual(
      expect.objectContaining({ canvasId: 'null-title-space', title: null }),
    );
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

  it('does not treat a filename as ownership when frontmatter names another node', async () => {
    await createSpace();
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    writeFileSync(
      path.join(nodesDir('canvas-a'), 'node-a.md'),
      '---\nid: node-b\ntype: note\nlabel: Impostor\n---\nbody\n',
      'utf8',
    );
    const repository = new DiskNodeRepository(getCanvasStore('canvas-a'));

    await expect(repository.read('node-a')).resolves.toBeNull();
    await expect(repository.read('node-b')).resolves.toMatchObject({
      record: { nodeId: 'node-b', label: 'Impostor', content: 'body\n' },
    });
  });

  it('rechecks frontmatter ownership before creating an apparently absent id', async () => {
    await createSpace();
    const repository = new DiskNodeRepository(getCanvasStore('canvas-a'));
    const stored = await repository.put({
      nodeId: 'node-a',
      record: note('node-a', 'Node A', 'before'),
    });
    if (!stored.ok) throw new Error('node seed failed');
    await repository.read('node-a');
    writeFileSync(
      path.join(nodesDir('canvas-a'), 'Node A.md'),
      '---\nid: node-b\ntype: note\nlabel: Node B\n---\nexternal\n',
      'utf8',
    );

    await expect(
      repository.put({
        nodeId: 'node-b',
        expectedRevision: null,
        record: note('node-b', 'Created B', 'new'),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'revision-conflict',
    });
    expect(readdirSync(nodesDir('canvas-a'))).toEqual(['Node A.md']);
  });

  it('rescans an equal-count sidecar replacement before mutating', async () => {
    await createSpace();
    const repository = new DiskNodeRepository(getCanvasStore('canvas-a'));
    await repository.put({
      nodeId: 'node-a',
      record: note('node-a', 'Node A', 'a'),
    });
    await repository.put({
      nodeId: 'node-b',
      record: note('node-b', 'Node B', 'b'),
    });
    await repository.read('node-a');

    unlinkSync(path.join(nodesDir('canvas-a'), 'Node B.md'));
    writeFileSync(
      path.join(nodesDir('canvas-a'), 'Duplicate A.md'),
      '---\nid: node-a\ntype: note\nlabel: Duplicate A\n---\nduplicate\n',
      'utf8',
    );

    await expect(
      repository.put({
        nodeId: 'node-a',
        record: note('node-a', 'Node A', 'updated'),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'duplicate-node' });
  });

  it('refuses to delete one arbitrary representative of a duplicate node', async () => {
    await createSpace();
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    for (const filename of ['Node A.md', 'Duplicate A.md']) {
      writeFileSync(
        path.join(nodesDir('canvas-a'), filename),
        `---\nid: node-a\ntype: note\nlabel: ${filename.replace(/\.md$/, '')}\n---\nbody\n`,
        'utf8',
      );
    }
    const repository = new DiskNodeRepository(getCanvasStore('canvas-a'));

    await expect(repository.delete('node-a')).rejects.toThrow(
      /multiple sidecars claim that id/,
    );
    expect(readdirSync(nodesDir('canvas-a')).sort()).toEqual([
      'Duplicate A.md',
      'Node A.md',
    ]);
  });

  it('refuses a batch delete when duplicate sidecars claim the node id', async () => {
    const before = await createSpace();
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    for (const filename of ['Node A.md', 'Duplicate A.md']) {
      writeFileSync(
        path.join(nodesDir('canvas-a'), filename),
        `---\nid: node-a\ntype: note\nlabel: ${filename.replace(/\.md$/, '')}\n---\nbody\n`,
        'utf8',
      );
    }
    const store = getCanvasStore('canvas-a');
    const writer = new DiskOrderedSpaceWriter(store);

    await expect(
      writer.apply({
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
