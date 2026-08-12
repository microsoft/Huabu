// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
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
import { DiskSpaceNodes } from './space-nodes.js';
import { DiskSpaceRepository } from './space-repository.js';
import { DiskStructuredStore } from './structured-store.js';
import { refreshCanvasDirIndex } from '../../../workspace/disk/canvas-dirs.js';
import { nodesDir } from '../../../workspace/disk/paths.js';
import { ensureWorldCanvasOnDisk } from '../../../workspace/disk/world-canvas.js';
import { setWorkspacePath } from '../../../workspace.js';
import { describeSpaceNodesContract } from '../../ports/contracts/space-nodes.contract.js';

import type { NodeContent } from '../../../canvas/persistence-types.js';

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

describeSpaceNodesContract('Disk', async () => {
  const root = freshWorkspace('huabu-node-contract-');
  const created = await new DiskSpaceRepository().create({
    canvasId: 'node-space',
    title: 'Node contract Space',
  });
  if (!created.ok) throw new Error('Node contract Space already exists');

  const store = new DiskStructuredStore();
  return {
    repository: store.space('node-space').nodes,
    missingRepository: store.space('missing-node-space').nodes,
    expectedCanvasId: 'node-space',
    cleanup: () => {
      vi.restoreAllMocks();
      resetStorageCache();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describe('DiskSpaceNodes', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = freshWorkspace('huabu-node-repository-');
    const created = await new DiskSpaceRepository(() => 1).create({
      canvasId: 'canvas-a',
      title: 'Shared title',
    });
    if (!created.ok) throw new Error('test Space already exists');
  });

  afterEach(() => {
    resetStorageCache();
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('uses full-record node CAS and returns the exact persisted record', async () => {
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));
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
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    writeFileSync(
      path.join(nodesDir('canvas-a'), 'node-a.md'),
      '---\nid: node-b\ntype: note\nlabel: Impostor\n---\nbody\n',
      'utf8',
    );
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));

    await expect(repository.read('node-a')).resolves.toBeNull();
    await expect(repository.read('node-b')).resolves.toMatchObject({
      record: { nodeId: 'node-b', label: 'Impostor', content: 'body\n' },
    });
  });

  it('rechecks frontmatter ownership before creating an apparently absent id', async () => {
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));
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
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));
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
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    for (const filename of ['Node A.md', 'Duplicate A.md']) {
      writeFileSync(
        path.join(nodesDir('canvas-a'), filename),
        `---\nid: node-a\ntype: note\nlabel: ${filename.replace(/\.md$/, '')}\n---\nbody\n`,
        'utf8',
      );
    }
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));

    await expect(repository.delete('node-a')).rejects.toThrow(
      /multiple sidecars claim that id/,
    );
    expect(readdirSync(nodesDir('canvas-a')).sort()).toEqual([
      'Duplicate A.md',
      'Node A.md',
    ]);
  });

  it('rejects malformed durable node state instead of reporting absence', async () => {
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    writeFileSync(
      path.join(nodesDir('canvas-a'), 'broken.md'),
      '---\nid: broken\nkeywords: [\n---\nbody',
      'utf8',
    );
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));

    await expect(repository.read('broken')).rejects.toThrow();
  });
});
