// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { isNodeTombstoned } from './legacy/node-tombstones.js';
import { DiskSpaceCommitter, type DiskCommitJournal } from './space-commit.js';
import { DiskSpaceLifecycleRepository } from './space-lifecycle.js';
import { DiskStructuredStore } from './structured-store.js';
import {
  abortPreparedDiskTransaction,
  applyPreparedDiskTransaction,
  discardUnappliedDiskTransaction,
  finalizeCommittedDiskTransaction,
  markPreparedDiskTransactionCommitted,
  prepareDiskTransaction,
  recoverDiskTransactions,
  validatePreparedDiskTransactionUnapplied,
} from './transaction-journal.js';
import { toSafeFilename } from '../../../workspace/disk/naming.js';
import {
  canvasJsonPath,
  nodeFilePath,
  workspaceTransactionsDir,
} from '../../../workspace/disk/paths.js';
import { registerSpaceDirHandleOwner } from '../../../workspace/disk/space-dir-handles.js';
import { setWorkspacePath } from '../../../workspace.js';

import type { NodeContent } from '../../../canvas/persistence-types.js';
import type { SpaceCommitInput } from '../../ports/structured.js';

const canvasId = 'journal-boundary';
const nodeId = 'node-a';

const publication = {
  originator: { source: 'system' as const },
  optimistic: false,
  commands: [],
  structureDeltas: [],
};

function realJournal(): DiskCommitJournal {
  return {
    prepare: prepareDiskTransaction,
    validateUnapplied: validatePreparedDiskTransactionUnapplied,
    discard: discardUnappliedDiskTransaction,
    apply: applyPreparedDiskTransaction,
    markCommitted: markPreparedDiskTransactionCommitted,
    finalize: finalizeCommittedDiskTransaction,
    abort: abortPreparedDiskTransaction,
  };
}

function topologyNode() {
  return {
    id: nodeId,
    type: 'note',
    position: { x: 0, y: 0 },
    data: { label: 'Node A' },
  };
}

const nodeRecord: NodeContent = {
  nodeId,
  type: 'note',
  label: 'Node A',
  content: 'durable content',
};

describe('DiskSpaceCommitter journal decision boundary', () => {
  let workspace = '';

  beforeEach(async () => {
    workspace = mkdtempSync(path.join(tmpdir(), 'huabu-commit-boundary-'));
    setWorkspacePath(workspace);
    resetStorageCache();
    const created = await new DiskSpaceLifecycleRepository().create({
      canvasId,
      title: 'Journal Boundary',
    });
    if (!created.ok)
      throw new Error(`fixture create failed: ${created.reason}`);
  });

  afterEach(() => {
    resetStorageCache();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('reports success after finalization fails and admits the next transaction', async () => {
    const actual = realJournal();
    const committer = new DiskSpaceCommitter(getCanvasStore(canvasId), {
      ...actual,
      finalize(): void {
        throw new Error('injected committed cleanup failure');
      },
    });
    const base = await new DiskStructuredStore().space(canvasId).record.read();
    if (!base) throw new Error('fixture missing');

    const first = await committer.commit({
      expectedVersion: base.version,
      record: { title: base.title, state: base.state },
      nodePreconditions: [],
      nodeMutations: [],
      publication,
      forceVersionBump: true,
    });
    expect(first).toMatchObject({ ok: true, committed: true });
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);

    const second = await committer.commit({
      expectedVersion: 1,
      record: { title: base.title, state: base.state },
      nodePreconditions: [],
      nodeMutations: [],
      publication,
      forceVersionBump: true,
    });
    expect(second).toMatchObject({
      ok: true,
      committed: true,
      record: { version: 2 },
    });
  });

  it('recovers an unmarked recreation without losing its prior durable tombstone', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const empty = await handle.record.read();
    if (!empty) throw new Error('fixture missing');
    const inserted = await handle.commit({
      expectedVersion: empty.version,
      record: {
        title: empty.title,
        state: { nodes: [topologyNode()], edges: [] },
      },
      nodePreconditions: [{ nodeId, revision: null }],
      nodeMutations: [{ kind: 'put', record: nodeRecord }],
      publication,
    });
    if (!inserted.ok) throw new Error(`insert failed: ${inserted.reason}`);

    const insertedNode = await handle.nodes.read(nodeId);
    if (!insertedNode) throw new Error('inserted node missing');
    const deleted = await handle.commit({
      expectedVersion: inserted.record.version,
      record: {
        title: inserted.record.title,
        state: { nodes: [], edges: [] },
      },
      nodePreconditions: [{ nodeId, revision: insertedNode.revision }],
      nodeMutations: [{ kind: 'delete', nodeId }],
      publication,
    });
    if (!deleted.ok) throw new Error(`delete failed: ${deleted.reason}`);
    expect(isNodeTombstoned(workspace, canvasId, nodeId)).toBe(true);

    const actual = realJournal();
    const crashing = new DiskSpaceCommitter(getCanvasStore(canvasId), {
      ...actual,
      markCommitted(): void {
        // The old durable suppression metadata must still exist in the exact
        // callback→marker window; recovery cannot restore what a crash has
        // already deleted outside the journal.
        expect(isNodeTombstoned(workspace, canvasId, nodeId)).toBe(true);
        throw new Error('injected marker failure');
      },
      abort(): void {
        // Leave the uncommitted after-state and journal in place, as a process
        // crash would. Startup recovery must consume both on the next boot.
        throw new Error('simulated crash before abort');
      },
    });
    const recreation: SpaceCommitInput = {
      expectedVersion: deleted.record.version,
      record: {
        title: deleted.record.title,
        state: { nodes: [topologyNode()], edges: [] },
      },
      nodePreconditions: [{ nodeId, revision: null }],
      nodeMutations: [{ kind: 'put', record: nodeRecord }],
      publication,
    };

    await expect(crashing.commit(recreation)).rejects.toThrow(
      'simulated crash before abort',
    );
    expect(isNodeTombstoned(workspace, canvasId, nodeId)).toBe(true);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toHaveLength(1);

    recoverDiskTransactions(workspace);
    resetStorageCache();
    const recovered = new DiskStructuredStore().space(canvasId);
    await expect(recovered.record.read()).resolves.toMatchObject({
      version: deleted.record.version,
      state: { nodes: [] },
    });
    await expect(recovered.nodes.read(nodeId)).resolves.toBeNull();
    expect(isNodeTombstoned(workspace, canvasId, nodeId)).toBe(true);
    expect(getCanvasStore(canvasId).isNodeWriteSuppressed(nodeId)).toBe(true);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
    expect(existsSync(path.join(workspace, '.huabu', 'tombstones'))).toBe(true);
  });

  it('checks OCC after handle release and leaves newer external bytes untouched', async () => {
    const base = await new DiskStructuredStore().space(canvasId).record.read();
    if (!base) throw new Error('fixture missing');
    const newer = {
      ...base,
      version: base.version + 1,
      state: { nodes: [{ id: 'external-node' }], edges: [] },
      updatedAt: base.updatedAt + 1,
    };
    let released = 0;
    const unregister = registerSpaceDirHandleOwner(canvasId, {
      release(): void {
        released += 1;
        writeFileSync(canvasJsonPath(canvasId), JSON.stringify(newer), 'utf8');
      },
      reacquire(): void {},
    });

    try {
      await expect(
        new DiskSpaceCommitter(getCanvasStore(canvasId)).commit({
          expectedVersion: base.version,
          record: { title: 'Renamed Boundary', state: base.state },
          nodePreconditions: [],
          nodeMutations: [],
          publication,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'version-conflict',
        actualVersion: newer.version,
      });
    } finally {
      unregister();
    }

    expect(released).toBe(1);
    expect(JSON.parse(readFileSync(canvasJsonPath(canvasId), 'utf8'))).toEqual(
      newer,
    );
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('rejects a same-version baseline change during handle release', async () => {
    const base = await new DiskStructuredStore().space(canvasId).record.read();
    if (!base) throw new Error('fixture missing');
    const external = {
      ...base,
      state: { nodes: [{ id: 'same-version-external' }], edges: [] },
      updatedAt: base.updatedAt + 1,
    };
    const unregister = registerSpaceDirHandleOwner(canvasId, {
      release(): void {
        writeFileSync(
          canvasJsonPath(canvasId),
          JSON.stringify(external),
          'utf8',
        );
      },
      reacquire(): void {},
    });

    try {
      await expect(
        new DiskSpaceCommitter(getCanvasStore(canvasId)).commit({
          expectedVersion: base.version,
          record: { title: 'Renamed Boundary', state: base.state },
          nodePreconditions: [],
          nodeMutations: [],
          publication,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'version-conflict',
        actualVersion: base.version,
      });
    } finally {
      unregister();
    }

    expect(JSON.parse(readFileSync(canvasJsonPath(canvasId), 'utf8'))).toEqual(
      external,
    );
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('preserves a Finder sibling that appears during release on strict rename conflict', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const base = await handle.record.read();
    if (!base) throw new Error('fixture missing');
    const inserted = await handle.commit({
      expectedVersion: base.version,
      record: {
        title: base.title,
        state: { nodes: [topologyNode()], edges: [] },
      },
      nodePreconditions: [{ nodeId, revision: null }],
      nodeMutations: [{ kind: 'put', record: { ...nodeRecord, label: 'Old' } }],
      publication,
    });
    if (!inserted.ok) throw new Error(`insert failed: ${inserted.reason}`);
    const beforeNode = await handle.nodes.read(nodeId);
    if (!beforeNode) throw new Error('inserted node missing');

    const siblingBytes =
      '---\nid: finder-sibling\ntype: note\nlabel: New\n---\nFinder bytes';
    const unregister = registerSpaceDirHandleOwner(canvasId, {
      release(): void {
        writeFileSync(nodeFilePath(canvasId, 'New.md'), siblingBytes, 'utf8');
      },
      reacquire(): void {},
    });
    try {
      await expect(
        handle.commit({
          expectedVersion: inserted.record.version,
          record: {
            title: 'Renamed Boundary',
            state: inserted.record.state,
          },
          nodePreconditions: [{ nodeId, revision: beforeNode.revision }],
          nodeMutations: [
            {
              kind: 'put',
              record: { ...nodeRecord, label: 'New' },
              strictRename: true,
            },
          ],
          publication,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason: 'node-name-conflict',
        nodeId,
        conflictWith: {
          id: 'finder-sibling',
          logicalName: 'New.md',
        },
      });
    } finally {
      unregister();
    }

    expect(readFileSync(nodeFilePath(canvasId, 'New.md'), 'utf8')).toBe(
      siblingBytes,
    );
    expect(readFileSync(nodeFilePath(canvasId, 'Old.md'), 'utf8')).toContain(
      'durable content',
    );
    await expect(handle.record.read()).resolves.toMatchObject({
      version: inserted.record.version,
      title: base.title,
    });
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('discards an unapplied stale plan without deleting a post-capture sibling', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const base = await handle.record.read();
    if (!base) throw new Error('fixture missing');
    const inserted = await handle.commit({
      expectedVersion: base.version,
      record: {
        title: base.title,
        state: { nodes: [topologyNode()], edges: [] },
      },
      nodePreconditions: [{ nodeId, revision: null }],
      nodeMutations: [{ kind: 'put', record: { ...nodeRecord, label: 'Old' } }],
      publication,
    });
    if (!inserted.ok) throw new Error(`insert failed: ${inserted.reason}`);
    const beforeNode = await handle.nodes.read(nodeId);
    if (!beforeNode) throw new Error('inserted node missing');

    const siblingBytes =
      '---\nid: post-capture-sibling\ntype: note\nlabel: New\n---\nPost-capture bytes';
    const actual = realJournal();
    const committer = new DiskSpaceCommitter(getCanvasStore(canvasId), {
      ...actual,
      prepare(input) {
        const prepared = actual.prepare(input);
        // Model a truly external process landing the planned target while the
        // synchronous journal directory is being published.
        writeFileSync(nodeFilePath(canvasId, 'New.md'), siblingBytes, 'utf8');
        return prepared;
      },
    });

    await expect(
      committer.commit({
        expectedVersion: inserted.record.version,
        record: { title: inserted.record.title, state: inserted.record.state },
        nodePreconditions: [{ nodeId, revision: beforeNode.revision }],
        nodeMutations: [
          {
            kind: 'put',
            record: { ...nodeRecord, label: 'New' },
            strictRename: true,
          },
        ],
        publication,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'node-name-conflict',
      conflictWith: {
        id: 'post-capture-sibling',
        logicalName: 'New.md',
      },
    });
    expect(readFileSync(nodeFilePath(canvasId, 'New.md'), 'utf8')).toBe(
      siblingBytes,
    );
    expect(readFileSync(nodeFilePath(canvasId, 'Old.md'), 'utf8')).toContain(
      'durable content',
    );
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('discards a post-prepare same-file edit without restoring stale bytes', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const base = await handle.record.read();
    if (!base) throw new Error('fixture missing');
    const inserted = await handle.commit({
      expectedVersion: base.version,
      record: {
        title: base.title,
        state: { nodes: [topologyNode()], edges: [] },
      },
      nodePreconditions: [{ nodeId, revision: null }],
      nodeMutations: [{ kind: 'put', record: { ...nodeRecord, label: 'Old' } }],
      publication,
    });
    if (!inserted.ok) throw new Error(`insert failed: ${inserted.reason}`);
    const beforeNode = await handle.nodes.read(nodeId);
    if (!beforeNode) throw new Error('inserted node missing');

    const externalBytes =
      '---\nid: node-a\ntype: note\nlabel: Old\n---\nNewer Finder content';
    const actual = realJournal();
    const committer = new DiskSpaceCommitter(getCanvasStore(canvasId), {
      ...actual,
      prepare(input) {
        const prepared = actual.prepare(input);
        writeFileSync(nodeFilePath(canvasId, 'Old.md'), externalBytes, 'utf8');
        return prepared;
      },
    });

    await expect(
      committer.commit({
        expectedVersion: inserted.record.version,
        record: { title: inserted.record.title, state: inserted.record.state },
        nodePreconditions: [{ nodeId, revision: beforeNode.revision }],
        nodeMutations: [
          {
            kind: 'put',
            record: { ...nodeRecord, label: 'Old', content: 'our content' },
          },
        ],
        publication,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'node-conflict',
      nodeId,
    });
    expect(readFileSync(nodeFilePath(canvasId, 'Old.md'), 'utf8')).toBe(
      externalBytes,
    );
    await expect(handle.record.read()).resolves.toMatchObject({
      version: inserted.record.version,
    });
    await expect(
      handle.deltas.readSince(inserted.record.version),
    ).resolves.toEqual([]);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('rejects a duplicate-node delete before changing topology, files, or version', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const base = await handle.record.read();
    if (!base) throw new Error('fixture missing');
    const inserted = await handle.commit({
      expectedVersion: base.version,
      record: {
        title: base.title,
        state: { nodes: [topologyNode()], edges: [] },
      },
      nodePreconditions: [{ nodeId, revision: null }],
      nodeMutations: [{ kind: 'put', record: nodeRecord }],
      publication,
    });
    if (!inserted.ok) throw new Error(`insert failed: ${inserted.reason}`);
    const beforeDelete = await handle.nodes.read(nodeId);
    if (!beforeDelete) throw new Error('inserted node missing');

    const primaryPath = nodeFilePath(canvasId, 'Node A.md');
    const primaryBytes = readFileSync(primaryPath);
    const duplicatePath = nodeFilePath(canvasId, 'Duplicate.md');
    const duplicateBytes = Buffer.from(
      '---\nid: node-a\ntype: note\nlabel: Duplicate\n---\nDuplicate bytes',
      'utf8',
    );
    writeFileSync(duplicatePath, duplicateBytes);

    await expect(
      handle.commit({
        expectedVersion: inserted.record.version,
        record: {
          title: inserted.record.title,
          state: { nodes: [], edges: [] },
        },
        nodePreconditions: [{ nodeId, revision: beforeDelete.revision }],
        nodeMutations: [{ kind: 'delete', nodeId }],
        publication,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'duplicate-node',
      nodeId,
      logicalNames: expect.arrayContaining(['Duplicate.md', 'Node A.md']),
    });

    expect(readFileSync(primaryPath)).toEqual(primaryBytes);
    expect(readFileSync(duplicatePath)).toEqual(duplicateBytes);
    expect(isNodeTombstoned(workspace, canvasId, nodeId)).toBe(false);
    await expect(handle.record.read()).resolves.toMatchObject({
      version: inserted.record.version,
      state: { nodes: [expect.objectContaining({ id: nodeId })] },
    });
    await expect(
      handle.deltas.readSince(inserted.record.version),
    ).resolves.toEqual([]);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('discards the journal when the title destination appears after final validation', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const base = await handle.record.read();
    if (!base) throw new Error('fixture missing');
    const destination = path.join(
      workspace,
      toSafeFilename('Renamed Boundary', canvasId),
    );
    const sentinel = path.join(destination, 'finder.txt');
    const actual = realJournal();
    const committer = new DiskSpaceCommitter(getCanvasStore(canvasId), {
      ...actual,
      validateUnapplied(transaction): void {
        actual.validateUnapplied(transaction);
        mkdirSync(destination);
        writeFileSync(sentinel, 'Finder destination', 'utf8');
      },
    });

    await expect(
      committer.commit({
        expectedVersion: base.version,
        record: { title: 'Renamed Boundary', state: base.state },
        nodePreconditions: [],
        nodeMutations: [],
        publication,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'title-conflict' });

    expect(readFileSync(sentinel, 'utf8')).toBe('Finder destination');
    expect(JSON.parse(readFileSync(canvasJsonPath(canvasId), 'utf8'))).toEqual(
      base,
    );
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);

    await expect(
      handle.commit({
        expectedVersion: base.version,
        record: { title: base.title, state: base.state },
        nodePreconditions: [],
        nodeMutations: [],
        publication,
        forceVersionBump: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      record: { version: base.version + 1 },
    });
  });

  it('discards the journal when the title source moves after final validation', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const base = await handle.record.read();
    if (!base) throw new Error('fixture missing');
    const originalRoot = path.dirname(canvasJsonPath(canvasId));
    const movedRoot = path.join(workspace, 'Finder Moved');
    const actual = realJournal();
    const committer = new DiskSpaceCommitter(getCanvasStore(canvasId), {
      ...actual,
      validateUnapplied(transaction): void {
        actual.validateUnapplied(transaction);
        renameSync(originalRoot, movedRoot);
      },
    });

    await expect(
      committer.commit({
        expectedVersion: base.version,
        record: { title: 'Renamed Boundary', state: base.state },
        nodePreconditions: [],
        nodeMutations: [],
        publication,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'not-found' });

    expect(existsSync(originalRoot)).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(movedRoot, 'space.json'), 'utf8')),
    ).toEqual(base);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
    expect(() => recoverDiskTransactions(workspace)).not.toThrow();

    const moved = await handle.record.read();
    if (!moved) throw new Error('Finder-moved Space missing');
    expect(moved.title).toBe('Finder Moved');
    await expect(
      handle.commit({
        expectedVersion: moved.version,
        record: { title: moved.title, state: moved.state },
        nodePreconditions: [],
        nodeMutations: [],
        publication,
        forceVersionBump: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      committed: true,
      record: { version: moved.version + 1, title: 'Finder Moved' },
    });
  });

  it('recovers a crash after the directory rename but before redo applies', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const base = await handle.record.read();
    if (!base) throw new Error('fixture missing');
    const originalRoot = path.dirname(canvasJsonPath(canvasId));
    const renamedRoot = path.join(workspace, 'Renamed Boundary');
    const actual = realJournal();
    const crashing = new DiskSpaceCommitter(getCanvasStore(canvasId), {
      ...actual,
      apply(): void {
        throw new Error('simulated crash before redo');
      },
      abort(): void {
        throw new Error('simulated process exit');
      },
    });

    await expect(
      crashing.commit({
        expectedVersion: base.version,
        record: { title: 'Renamed Boundary', state: base.state },
        nodePreconditions: [],
        nodeMutations: [],
        publication,
      }),
    ).rejects.toThrow('simulated process exit');
    expect(existsSync(originalRoot)).toBe(false);
    expect(existsSync(renamedRoot)).toBe(true);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toHaveLength(1);

    recoverDiskTransactions(workspace);
    resetStorageCache();
    expect(existsSync(renamedRoot)).toBe(false);
    expect(existsSync(originalRoot)).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(originalRoot, 'space.json'), 'utf8')),
    ).toEqual(base);
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });

  it('journals the refreshed non-strict dedupe target before rollback', async () => {
    const handle = new DiskStructuredStore().space(canvasId);
    const base = await handle.record.read();
    if (!base) throw new Error('fixture missing');
    const inserted = await handle.commit({
      expectedVersion: base.version,
      record: {
        title: base.title,
        state: { nodes: [topologyNode()], edges: [] },
      },
      nodePreconditions: [{ nodeId, revision: null }],
      nodeMutations: [{ kind: 'put', record: { ...nodeRecord, label: 'Old' } }],
      publication,
    });
    if (!inserted.ok) throw new Error(`insert failed: ${inserted.reason}`);
    const beforeNode = await handle.nodes.read(nodeId);
    if (!beforeNode) throw new Error('inserted node missing');

    const siblingBytes =
      '---\nid: finder-sibling\ntype: note\nlabel: New\n---\nFinder bytes';
    const unregister = registerSpaceDirHandleOwner(canvasId, {
      release(): void {
        writeFileSync(nodeFilePath(canvasId, 'New.md'), siblingBytes, 'utf8');
      },
      reacquire(): void {},
    });
    const actual = realJournal();
    const crashing = new DiskSpaceCommitter(getCanvasStore(canvasId), {
      ...actual,
      markCommitted(): void {
        throw new Error('injected pre-marker failure');
      },
    });
    try {
      await expect(
        crashing.commit({
          expectedVersion: inserted.record.version,
          record: {
            title: 'Renamed Boundary',
            state: inserted.record.state,
          },
          nodePreconditions: [{ nodeId, revision: beforeNode.revision }],
          nodeMutations: [
            { kind: 'put', record: { ...nodeRecord, label: 'New' } },
          ],
          publication,
        }),
      ).rejects.toThrow('injected pre-marker failure');
    } finally {
      unregister();
    }

    expect(readFileSync(nodeFilePath(canvasId, 'New.md'), 'utf8')).toBe(
      siblingBytes,
    );
    expect(existsSync(nodeFilePath(canvasId, 'New (2).md'))).toBe(false);
    expect(readFileSync(nodeFilePath(canvasId, 'Old.md'), 'utf8')).toContain(
      'durable content',
    );
    await expect(handle.record.read()).resolves.toMatchObject({
      version: inserted.record.version,
      title: base.title,
    });
    expect(readdirSync(workspaceTransactionsDir(workspace))).toEqual([]);
  });
});
