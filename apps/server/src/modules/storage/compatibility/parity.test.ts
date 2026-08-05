/**
 * Parity between the compatibility facade and the composite handle.
 *
 * Phase 2 leaves two live views of the same Space. They must not become two
 * in-memory authorities: `DiskStructuredStore.space(id)` and
 * `getCanvasStore(id)` resolve the same cached legacy object, so a write
 * through either is immediately visible through the other.
 *
 * That property is what makes the phase safe to ship with the facade still in
 * place, so it is asserted directly rather than left as a design claim.
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
  it('shows a repository CAS through the facade', async () => {
    const handle = new DiskStructuredStore().space(CANVAS_ID);
    const current = await handle.record.read();

    const result = await handle.record.compareAndSwap(current!.version, {
      ...current!,
      version: current!.version + 1,
      state: { nodes: [{ id: 'n1' }], edges: [] },
      updatedAt: current!.updatedAt + 1,
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
    const throughRepository = await handle.record.read();
    expect(throughRepository?.version).toBe(current.version + 1);
    expect(throughRepository?.state.nodes).toEqual([{ id: 'n2' }]);
  });

  it('shows a facade node write through the handle, and back', async () => {
    getCanvasStore(CANVAS_ID).writeNode('n1', nodeContent('n1', 'from facade'));

    const handle = new DiskStructuredStore().space(CANVAS_ID);
    expect(handle.nodes.readNode('n1')?.content).toBe('from facade');

    handle.nodes.writeNode('n2', nodeContent('n2', 'from handle'));
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
  it('lifts the in-memory node tombstone when a structural CAS re-lists the node', async () => {
    const handle = new DiskStructuredStore().space(CANVAS_ID);

    // Delete the node: the sidecar goes, and an in-memory tombstone starts
    // suppressing late in-flight writes for that id.
    handle.nodes.writeNode('n1', nodeContent('n1', 'body'));
    expect(handle.nodes.deleteNode('n1')).toBe('deleted');
    expect(handle.nodes.isNodeWriteSuppressed('n1')).toBe(true);

    // A structural write that re-lists the id is the undo/redo path: the node
    // is alive again, so its content writes must be allowed through. This is
    // a Disk cross-surface invariant rather than a portable SpaceRepository
    // promise, so it is asserted here — but it has to keep holding when the
    // structural write arrives through the repository rather than the class.
    const restored = await handle.record.read();
    await handle.record.compareAndSwap(restored!.version, {
      ...restored!,
      version: restored!.version + 1,
      state: { nodes: [{ id: 'n1' }], edges: [] },
      updatedAt: restored!.updatedAt + 1,
    });
    expect(handle.nodes.isNodeWriteSuppressed('n1')).toBe(false);

    // Now drop the node from structure again *without* deleting the sidecar.
    // This is what separates a genuinely cleared tombstone from the escape
    // hatch: presence in structure also returns false while deliberately
    // keeping the tombstone alive, so the assertion above passes either way.
    // If the CAS had merely been escape-hatched, the id would start
    // suppressing again the moment it left structure.
    const emptied = await handle.record.read();
    await handle.record.compareAndSwap(emptied!.version, {
      ...emptied!,
      version: emptied!.version + 1,
      state: { nodes: [], edges: [] },
      updatedAt: emptied!.updatedAt + 1,
    });

    expect(handle.nodes.isNodeWriteSuppressed('n1')).toBe(false);
  });

  it('exposes no record, log, title, or lifecycle operation on handle.nodes', () => {
    const { nodes } = new DiskStructuredStore().space(CANVAS_ID);

    // `nodes` is a wrapper, not the legacy object: the forbidden surface is
    // absent rather than merely undocumented, so it cannot be reached by a
    // cast either.
    for (const forbidden of [
      'read',
      'write',
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
    ]) {
      expect(nodes).not.toHaveProperty(forbidden);
    }

    // And the node surface it is supposed to carry is all there.
    for (const allowed of [
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
    ]) {
      expect(
        typeof (nodes as unknown as Record<string, unknown>)[allowed],
      ).toBe('function');
    }
  });
});
