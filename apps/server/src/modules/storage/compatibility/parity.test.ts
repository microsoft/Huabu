// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Parity between the compatibility facade and the composite handle.
 *
 * The compatibility facade leaves two live views of the same Space. They must
 * not become two in-memory authorities: `DiskStructuredStore.space(id)` and
 * `getCanvasStore(id)` resolve the same cached legacy object, so a write
 * through either is immediately visible through the other.
 *
 * That property is what makes it safe to ship the ports with the facade still
 * in place, so it is asserted directly rather than left as a design claim.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
}));

import { toSafeFilename } from '../../../utils/naming.js';
import { refreshCanvasDirIndex } from '../backends/disk/canvas-dirs.js';
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
  it('shows a repository record write through the facade', async () => {
    const handle = new DiskStructuredStore().space(CANVAS_ID);
    const current = await handle.read();

    const result = await handle.write({
      expectedVersion: current!.version,
      nextRecord: {
        ...current!,
        version: current!.version + 1,
        state: { nodes: [{ id: 'n1' }], edges: [] },
        updatedAt: current!.updatedAt + 1,
      },
      nodeMutations: [],
    });
    expect(result).toEqual({ ok: true });

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
    const throughRepository = await handle.read();
    expect(throughRepository?.version).toBe(current.version + 1);
    expect(throughRepository?.state.nodes).toEqual([{ id: 'n2' }]);
  });

  it('shows a facade node write through the handle, and back', async () => {
    getCanvasStore(CANVAS_ID).writeNode('n1', nodeContent('n1', 'from facade'));

    const handle = new DiskStructuredStore().space(CANVAS_ID);
    expect((await handle.nodes.read('n1'))?.record.content).toBe('from facade');

    await handle.nodes.put({
      nodeId: 'n2',
      record: nodeContent('n2', 'from handle'),
    });
    expect(getCanvasStore(CANVAS_ID).readNode('n2')?.content).toBe(
      'from handle',
    );
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
  it('lifts the in-memory node tombstone when a structural write re-lists the node', async () => {
    const handle = new DiskStructuredStore().space(CANVAS_ID);
    const store = getCanvasStore(CANVAS_ID);

    // Delete the node: the sidecar goes, and an in-memory tombstone starts
    // suppressing late in-flight writes for that id.
    await handle.nodes.put({
      nodeId: 'n1',
      record: nodeContent('n1', 'body'),
    });
    await expect(handle.nodes.delete('n1')).resolves.toBe('deleted');
    expect(store.isNodeWriteSuppressed('n1')).toBe(true);

    // A structural write that re-lists the id is the undo/redo path: the node
    // is alive again, so its content writes must be allowed through. This is
    // a Disk cross-surface invariant rather than a portable writer promise, so
    // it is asserted here — but it has to keep holding when the structural
    // write arrives through the port rather than the class.
    const restored = await handle.read();
    await handle.write({
      expectedVersion: restored!.version,
      nextRecord: {
        ...restored!,
        version: restored!.version + 1,
        state: { nodes: [{ id: 'n1' }], edges: [] },
        updatedAt: restored!.updatedAt + 1,
      },
      nodeMutations: [],
    });
    expect(store.isNodeWriteSuppressed('n1')).toBe(false);

    // Now drop the node from structure again *without* deleting the sidecar.
    // This is what separates a genuinely cleared tombstone from the escape
    // hatch: presence in structure also returns false while deliberately
    // keeping the tombstone alive, so the assertion above passes either way.
    // If the structural write had merely been escape-hatched, the id would
    // start suppressing again the moment it left structure.
    const emptied = await handle.read();
    await handle.write({
      expectedVersion: emptied!.version,
      nextRecord: {
        ...emptied!,
        version: emptied!.version + 1,
        state: { nodes: [], edges: [] },
        updatedAt: emptied!.updatedAt + 1,
      },
      nodeMutations: [],
    });

    expect(store.isNodeWriteSuppressed('n1')).toBe(false);
  });

  it('exposes no record, log, title, or lifecycle operation on handle.nodes', () => {
    const { nodes } = new DiskStructuredStore().space(CANVAS_ID);

    // `nodes` is a wrapper, not the legacy object: the forbidden surface is
    // absent rather than merely undocumented, so it cannot be reached by a
    // cast either.
    for (const forbidden of [
      'write',
      'readNode',
      'readAllNodes',
      'streamAllNodes',
      'writeNode',
      'deleteNode',
      'nodeIdForFilename',
      'isDuplicateNode',
      'duplicateNodeFiles',
      'revalidateNodeForRead',
      'isNodeWriteSuppressed',
      'renameSelf',
      'destroy',
      'appendEvents',
      'readEvents',
      'appendDeltaLogEntry',
      'readDeltaLogSince',
      'readChanges',
      'appendChanges',
      'removeChange',
    ]) {
      expect(nodes).not.toHaveProperty(forbidden);
    }

    // And the node surface it is supposed to carry is all there.
    expect(nodes.canvasId).toBe(CANVAS_ID);
    for (const allowed of ['read', 'put', 'delete']) {
      expect(
        typeof (nodes as unknown as Record<string, unknown>)[allowed],
      ).toBe('function');
    }
  });
});
