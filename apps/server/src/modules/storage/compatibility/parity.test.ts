// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Compatibility reads and physical fixture setup remain coherent with the
 * structured handle while aggregate mutation has one public authority.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { refreshCanvasDirIndex } from '../../workspace/disk/canvas-dirs.js';
import { toSafeFilename } from '../../workspace/disk/naming.js';
import {
  getCanvasStore,
  resetStorageCache,
} from '../backends/disk/legacy/canvas-store-cache.js';
import { DiskStructuredStore } from '../backends/disk/structured-store.js';

import type { CanvasFile } from '../../canvas/persistence-types.js';

const CANVAS_ID = 'canvas-a';
const TITLE = 'Canvas A';

let root = '';

function seedSpace(): CanvasFile {
  const dir = path.join(root, toSafeFilename(TITLE, CANVAS_ID));
  mkdirSync(dir, { recursive: true });
  const record: CanvasFile = {
    canvasId: CANVAS_ID,
    title: TITLE,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: 1,
    updatedAt: 1,
  };
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify(record), 'utf8');
  refreshCanvasDirIndex();
  return record;
}

function nodeContent(nodeId: string, content: string) {
  return { nodeId, type: 'note', label: nodeId, content };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'huabu-parity-'));
  workspaceState.path = root;
  resetStorageCache();
  seedSpace();
});

afterEach(() => {
  resetStorageCache();
  rmSync(root, { recursive: true, force: true });
});

describe('compatibility facade and composite handle observe each other', () => {
  it('shows an aggregate commit through the facade', async () => {
    const handle = new DiskStructuredStore().space(CANVAS_ID);
    const current = await handle.record.read();

    const result = await handle.commit({
      expectedVersion: current!.version,
      record: {
        title: current!.title,
        state: { nodes: [{ id: 'n1' }], edges: [] },
      },
      nodePreconditions: [],
      nodeMutations: [],
      publication: {
        originator: { source: 'system' },
        optimistic: false,
        commands: [],
        structureDeltas: [],
      },
    });
    expect(result).toMatchObject({ ok: true, committed: true });

    const throughFacade = getCanvasStore(CANVAS_ID).read();
    expect(throughFacade?.version).toBe(current!.version + 1);
    expect(throughFacade?.state.nodes).toEqual([{ id: 'n1' }]);
  });

  it('shows a facade write through the repository', async () => {
    const store = getCanvasStore(CANVAS_ID);
    const current = store.read()!;
    store.write({
      ...current,
      version: current.version + 1,
      state: { nodes: [{ id: 'n2' }], edges: [] },
      updatedAt: current.updatedAt + 1,
    });

    const handle = new DiskStructuredStore().space(CANVAS_ID);
    const throughRepository = await handle.record.read();
    expect(throughRepository?.version).toBe(current.version + 1);
    expect(throughRepository?.state.nodes).toEqual([{ id: 'n2' }]);
  });

  it('shows a facade node fixture through the read-only repository', async () => {
    getCanvasStore(CANVAS_ID).writeNode('n1', nodeContent('n1', 'from facade'));

    const { nodes } = new DiskStructuredStore().space(CANVAS_ID);
    expect((await nodes.read('n1'))?.record.content).toBe('from facade');
  });

  it('shows a repository log append through the facade', async () => {
    const handle = new DiskStructuredStore().space(CANVAS_ID);
    await handle.events.append([
      {
        payload: {
          action: 'node_selected',
          node: { id: 'n1', type: 'note', label: 'n1' },
        },
        ts: 7,
      },
    ]);

    expect(
      getCanvasStore(CANVAS_ID)
        .readEvents()
        .map((e) => e.ts),
    ).toEqual([7]);
  });
});

describe('cross-surface Disk invariants', () => {
  it('lifts the node tombstone when an aggregate commit re-lists the node', async () => {
    const handle = new DiskStructuredStore().space(CANVAS_ID);
    const store = getCanvasStore(CANVAS_ID);

    // Delete the node: the sidecar goes, and an in-memory tombstone starts
    // suppressing late in-flight writes for that id.
    store.writeNode('n1', nodeContent('n1', 'body'));
    expect(store.deleteNode('n1')).toBe('deleted');
    expect(store.isNodeWriteSuppressed('n1')).toBe(true);

    // A structural commit that re-lists the id is the undo/redo path: the node
    // is alive again, so its content writes must be allowed through. This is
    // a Disk cross-surface invariant rather than a read-repository promise.
    const restored = await handle.record.read();
    await handle.commit({
      expectedVersion: restored!.version,
      record: {
        title: restored!.title,
        state: { nodes: [{ id: 'n1' }], edges: [] },
      },
      nodePreconditions: [],
      nodeMutations: [],
      publication: {
        originator: { source: 'system' },
        optimistic: false,
        commands: [],
        structureDeltas: [],
      },
    });
    expect(store.isNodeWriteSuppressed('n1')).toBe(false);

    // Now drop the node from structure again *without* deleting the sidecar.
    // This is what separates a genuinely cleared tombstone from the escape
    // hatch: presence in structure also returns false while deliberately
    // keeping the tombstone alive, so the assertion above passes either way.
    // If the prior commit had merely escape-hatched it, the id would start
    // suppressing again the moment it left structure.
    const emptied = await handle.record.read();
    await handle.commit({
      expectedVersion: emptied!.version,
      record: { title: emptied!.title, state: { nodes: [], edges: [] } },
      nodePreconditions: [],
      nodeMutations: [],
      publication: {
        originator: { source: 'system' },
        optimistic: false,
        commands: [],
        structureDeltas: [],
      },
    });

    expect(store.isNodeWriteSuppressed('n1')).toBe(false);
  });

  it('exposes only asynchronous reads on handle.nodes', () => {
    const handle = new DiskStructuredStore().space(CANVAS_ID);
    const { nodes } = handle;

    expect(handle).not.toHaveProperty('legacyNodes');
    expect(handle.record).not.toHaveProperty('compareAndSwap');
    expect(handle.deltas).not.toHaveProperty('append');

    // The portable repository is a wrapper, not the legacy object: both the
    // wider CanvasStore surface and every node mutation are absent at runtime.
    for (const forbidden of [
      'write',
      'writeNode',
      'deleteNode',
      'readNode',
      'readAllNodes',
      'streamAllNodes',
      'renameSelf',
      'destroy',
      'appendEvents',
      'readEvents',
      'appendDeltaLogEntry',
      'readDeltaLogSince',
      'readChanges',
      'appendChanges',
      'removeChange',
      'readIntents',
      'upsertIntent',
      'canvasId',
      'nodeIdForFilename',
      'isDuplicateNode',
      'duplicateNodeFiles',
      'revalidateNodeForRead',
      'isNodeWriteSuppressed',
    ]) {
      expect(nodes).not.toHaveProperty(forbidden);
    }

    for (const allowed of ['read', 'readMany']) {
      expect(
        typeof (nodes as unknown as Record<string, unknown>)[allowed],
      ).toBe('function');
    }
  });
});
