// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  chmodSync,
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

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { nodesDir } from './layout.js';
import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { DiskSpaceNodes } from './space-nodes.js';
import { DiskSpaceRepository } from './space-repository.js';
import { DiskStructuredStore } from './structured-store.js';
import { ensureWorldCanvasOnDisk } from './world-canvas.js';
import { setWorkspacePath } from '../../../workspace.js';
import { describeSpaceNodesContract } from '../../ports/contracts/space-nodes.contract.js';

import type { NodeContent } from '../../../canvas/persistence-types.js';
import type { NodeSnapshot } from '../../ports/structured.js';

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

  it('deletes the indexed representative of a duplicate node', async () => {
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    for (const filename of ['Node A.md', 'Duplicate A.md']) {
      writeFileSync(
        path.join(nodesDir('canvas-a'), filename),
        `---\nid: node-a\ntype: note\nlabel: ${filename.replace(/\.md$/, '')}\n---\nbody\n`,
        'utf8',
      );
    }
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));

    // `put` refuses a duplicated id — it cannot know which representation the
    // caller meant to update. Delete does not have that problem, and refusing
    // it would strand the node: duplicate sidecars are exactly the state a
    // user resolves by deleting.
    await expect(repository.delete('node-a')).resolves.toBe('deleted');
    expect(readdirSync(nodesDir('canvas-a'))).toEqual(['Duplicate A.md']);
  });

  it('recovers a node whose frontmatter a user broke by hand', async () => {
    mkdirSync(nodesDir('canvas-a'), { recursive: true });
    writeFileSync(
      path.join(nodesDir('canvas-a'), 'broken.md'),
      '---\nid: broken\nkeywords: [\n---\nbody',
      'utf8',
    );
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));

    // Unparseable frontmatter is not a read failure: a sidecar is a
    // hand-editable file, and rejecting here would leave the node visible
    // through the lenient GET while the content PUT and the DELETE route both
    // answered 500 — visible, unrepairable, undeletable.
    await expect(repository.read('broken')).resolves.toMatchObject({
      record: { nodeId: 'broken', content: 'body' },
    });

    // The collection shapes recover it the same way. They are strict about
    // reaching a sidecar, not about what a user typed inside one, so a scan
    // never refuses a node the per-id read repairs.
    const recovered = await repository.read('broken');
    await expect(repository.list()).resolves.toEqual(
      new Map([['broken', recovered]]),
    );
    const delivered: NodeSnapshot[] = [];
    await expect(
      repository.stream((snapshot) => delivered.push(snapshot)),
    ).resolves.toEqual(new Map([['broken', recovered]]));
    expect(delivered).toEqual([recovered]);

    await expect(
      repository.put({
        nodeId: 'broken',
        record: note('broken', 'Repaired', 'body'),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(repository.delete('broken')).resolves.toBe('deleted');
  });

  it('still surfaces an unreadable sidecar rather than reporting absence', async () => {
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));
    const stored = await repository.put({
      nodeId: 'node-a',
      record: note('node-a', 'Node A', 'body'),
    });
    if (!stored.ok) throw new Error('node seed failed');

    // Swap the sidecar for a directory of the same name. The filename set on
    // disk is unchanged, so the index still claims the id — the read has to
    // report the I/O failure rather than collapse it into "no such node".
    const sidecar = path.join(nodesDir('canvas-a'), 'Node A.md');
    unlinkSync(sidecar);
    mkdirSync(sidecar);

    await expect(repository.read('node-a')).rejects.toMatchObject({
      code: 'EISDIR',
    });

    // The collection shapes have to agree. A scan that swallowed the failure
    // would report an empty Space to an executor prestate hydration or a
    // bundle export while the per-id read still refused — the same node,
    // absent through one shape and an I/O error through another.
    await expect(repository.list()).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(
      repository.stream(() => {
        throw new Error('no node should be delivered from an unreadable scan');
      }),
    ).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('stops a strict scan at the first unreadable sidecar', async () => {
    const repository = new DiskSpaceNodes(getCanvasStore('canvas-a'));
    for (const nodeId of ['node-a', 'node-b', 'node-c']) {
      const stored = await repository.put({
        nodeId,
        record: note(nodeId, `Node ${nodeId}`, 'body'),
      });
      if (!stored.ok) throw new Error('node seed failed');
    }
    const sidecar = path.join(
      nodesDir('canvas-a'),
      readdirSync(nodesDir('canvas-a'))[0],
    );
    unlinkSync(sidecar);
    mkdirSync(sidecar);

    const delivered: NodeSnapshot[] = [];
    await expect(
      repository.stream((snapshot) => delivered.push(snapshot)),
    ).rejects.toMatchObject({ code: 'EISDIR' });

    // Delivering some of the readable siblings first is unavoidable: they are
    // in flight concurrently. Delivering *after* the caller has been handed
    // the error is not, and it is the half a caller cannot defend against —
    // it has already unwound whatever it was collecting into.
    const atRejection = delivered.length;
    expect(atRejection).toBeLessThan(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delivered).toHaveLength(atRejection);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a cold-cache unreadable sidecar without overwriting it',
    async () => {
      mkdirSync(nodesDir('canvas-a'), { recursive: true });
      const sidecar = path.join(nodesDir('canvas-a'), 'Cold.md');
      const original =
        '---\nid: node-a\ntype: note\nlabel: Cold\n---\nsecret\n';
      writeFileSync(sidecar, original, 'utf8');
      chmodSync(sidecar, 0o000);

      // Construct the adapter only after the unreadable file exists: no warm
      // filename cache may hide a scan failure as an absent node.
      const coldRepository = new DiskSpaceNodes(getCanvasStore('canvas-a'));
      let readError: unknown;
      let putError: unknown;
      try {
        await coldRepository.read('node-a');
      } catch (error) {
        readError = error;
      }

      // The old CanvasStore surface remains deliberately lenient, but a
      // portable adapter must not trust the incomplete index it populated.
      resetStorageCache();
      const compatibilityStore = getCanvasStore('canvas-a');
      const compatibilityContents = await compatibilityStore.readAllNodes();
      const repository = new DiskSpaceNodes(compatibilityStore);
      try {
        await repository.put({
          nodeId: 'node-a',
          expectedRevision: null,
          record: note('node-a', 'Cold', 'replacement'),
        });
      } catch (error) {
        putError = error;
      } finally {
        chmodSync(sidecar, 0o600);
      }

      expect(readError).toMatchObject({ code: 'EACCES' });
      expect(compatibilityContents.has('node-a')).toBe(false);
      expect(putError).toMatchObject({ code: 'EACCES' });
      expect(readFileSync(sidecar, 'utf8')).toBe(original);
    },
  );
});
