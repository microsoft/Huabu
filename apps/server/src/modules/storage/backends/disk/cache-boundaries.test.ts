import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  forgetCanvasStore,
  getCanvasStore,
  resetStorageCache,
} from './legacy/canvas-store-cache.js';
import { NODE_TOMBSTONE_TTL_MS } from './legacy/node-tombstones.js';
import { DiskStructuredStore } from './structured-store.js';
import {
  refreshCanvasDirIndex,
  registerCanvasDir,
} from '../../../workspace/disk/canvas-dirs.js';
import { toSafeFilename } from '../../../workspace/disk/naming.js';
import {
  canvasRoot,
  SPACE_JSON_FILENAME,
} from '../../../workspace/disk/paths.js';
import { setWorkspacePath } from '../../../workspace.js';

import type {
  DeltaLogEntry,
  CanvasFile,
  NodeContent,
} from '../../../canvas/persistence-types.js';

const roots: string[] = [];
let activeRoot = '';

function activateWorkspace(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  // Deliberately do not call resetStorageCache(): these tests cover the direct
  // activation path that production exposes.
  setWorkspacePath(root);
  activeRoot = root;
  return root;
}

function createSpace(canvasId: string, title: string): CanvasFile {
  const now = Date.now();
  const record: CanvasFile = {
    canvasId,
    title,
    version: 0,
    state: { nodes: [], edges: [] },
    createdAt: now,
    updatedAt: now,
  };
  const root = path.join(activeRoot, toSafeFilename(title, canvasId));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, SPACE_JSON_FILENAME),
    JSON.stringify(record),
    'utf8',
  );
  refreshCanvasDirIndex();
  return record;
}

function note(nodeId: string, label: string, content = 'body'): NodeContent {
  return { nodeId, type: 'note', label, content };
}

function delta(version: number): DeltaLogEntry {
  return {
    version,
    ts: version,
    commands: [],
    deltas: [],
    originator: { source: 'agent' },
  };
}

afterEach(() => {
  vi.useRealTimers();
  resetStorageCache();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CanvasStore cache boundaries', () => {
  it('allows cache cleanup before a workspace has been activated', () => {
    expect(() => resetStorageCache()).not.toThrow();
    expect(() => forgetCanvasStore('canvas-a')).not.toThrow();
  });

  it('keeps a live node tombstone across LRU eviction until its TTL expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    activateWorkspace('sediment-tombstone-cache-');

    const record = createSpace('canvas-a', 'Canvas A');
    const first = getCanvasStore('canvas-a');
    first.write({
      ...record,
      version: 1,
      state: { nodes: [{ id: 'n1' }], edges: [] },
      updatedAt: record.updatedAt + 1,
    });
    expect(first.writeNode('n1', note('n1', 'Note')).ok).toBe(true);
    expect(first.deleteNode('n1')).toBe('deleted');

    // The structural delete lands after the sidecar delete. Until this write,
    // presence in structure is the deliberate delete-before-autosave escape.
    first.write({
      ...(first.read() as CanvasFile),
      version: 2,
      state: { nodes: [], edges: [] },
      updatedAt: record.updatedAt + 2,
    });
    expect(first.isNodeWriteSuppressed('n1')).toBe(true);

    for (let i = 0; i < 20; i += 1) getCanvasStore(`filler-${i}`);
    const afterEviction = getCanvasStore('canvas-a');
    expect(afterEviction).not.toBe(first);
    expect(afterEviction.isNodeWriteSuppressed('n1')).toBe(true);

    vi.advanceTimersByTime(NODE_TOMBSTONE_TTL_MS - 1);
    expect(afterEviction.isNodeWriteSuppressed('n1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(afterEviction.isNodeWriteSuppressed('n1')).toBe(false);
  });

  it('invalidates cache state on a direct workspace switch and rejects a held handle', () => {
    const firstRoot = activateWorkspace('sediment-cache-workspace-a-');
    createSpace('shared-id', 'First');
    const held = getCanvasStore('shared-id');
    expect(held.writeNode('node-a', note('node-a', 'From A')).ok).toBe(true);
    expect(held.nodeIdForFilename('From A.md')).toBe('node-a');

    activateWorkspace('sediment-cache-workspace-b-');
    createSpace('shared-id', 'Second');
    const active = getCanvasStore('shared-id');
    expect(active).not.toBe(held);
    expect(active.writeNode('node-b', note('node-b', 'From B')).ok).toBe(true);
    expect(active.nodeIdForFilename('From B.md')).toBe('node-b');

    // The old instance has a warm filename index from workspace A. It must not
    // be allowed to consult that index — or the new workspace's disk — while B
    // is active.
    expect(() => held.nodeIdForFilename('From B.md')).toThrow(
      /inactive workspace.*Resolve a fresh Space handle/s,
    );
    expect(() => held.readNode('node-a')).toThrow(/inactive workspace/);

    // Switching back also invalidates B's cache rather than reviving A's old
    // instance and its potentially stale in-memory index.
    setWorkspacePath(firstRoot);
    const reopened = getCanvasStore('shared-id');
    expect(reopened).not.toBe(held);
    expect(reopened.nodeIdForFilename('From A.md')).toBe('node-a');
  });

  it('refreshes directory identity when workspaces reuse one directory name', () => {
    activateWorkspace('sediment-cache-collision-a-');
    createSpace('canvas-a', 'Shared');
    expect(getCanvasStore('canvas-a').read()?.canvasId).toBe('canvas-a');

    activateWorkspace('sediment-cache-collision-b-');
    createSpace('canvas-b', 'Shared');

    // Model the stale process-global mapping that existed before activation:
    // `canvas-a -> Shared`. Cache activation must refresh the index before it
    // constructs a handle, otherwise reading A resolves B's same-named file.
    registerCanvasDir('canvas-a', 'Shared', 'Shared');
    expect(getCanvasStore('canvas-a').read()).toBeNull();
    expect(getCanvasStore('canvas-b').read()?.canvasId).toBe('canvas-b');
  });

  it('rejects held event and delta repositories after a workspace switch', async () => {
    activateWorkspace('sediment-log-workspace-a-');
    createSpace('shared-id', 'First');
    const held = new DiskStructuredStore().space('shared-id');
    await held.events.append([
      {
        payload: {
          action: 'node_selected',
          node: { id: 'from-a', type: 'note', label: 'From A' },
        },
        ts: 1,
      },
    ]);
    await held.deltas.append(delta(1));

    activateWorkspace('sediment-log-workspace-b-');
    createSpace('shared-id', 'Second');
    const active = new DiskStructuredStore().space('shared-id');
    await active.events.append([
      {
        payload: {
          action: 'node_selected',
          node: { id: 'from-b', type: 'note', label: 'From B' },
        },
        ts: 2,
      },
    ]);
    await active.deltas.append(delta(2));

    // These reads use strict JSONL helpers directly. Without their own
    // workspace-lifetime guard, the retained A facades would silently read
    // B's same-id files instead of rejecting the stale handle.
    await expect(held.events.read()).rejects.toThrow(/inactive workspace/);
    await expect(held.deltas.readSince(0)).rejects.toThrow(
      /inactive workspace/,
    );
    expect((await active.events.read()).map((event) => event.ts)).toEqual([2]);
    expect(
      (await active.deltas.readSince(0)).map((entry) => entry.version),
    ).toEqual([2]);
  });

  it('guards a held record repository before probing the active workspace', async () => {
    activateWorkspace('sediment-record-workspace-a-');
    const first = createSpace('shared-id', 'First');
    const held = new DiskStructuredStore().space('shared-id');
    await expect(held.record.read()).resolves.toMatchObject({ title: 'First' });

    activateWorkspace('sediment-record-workspace-b-');
    createSpace('shared-id', 'Second');
    const active = new DiskStructuredStore().space('shared-id');
    await expect(active.record.read()).resolves.toMatchObject({
      title: 'Second',
    });

    await expect(held.record.read()).rejects.toThrow(/inactive workspace/);
    await expect(
      held.record.compareAndSwap(first.version, {
        ...first,
        version: first.version + 1,
        updatedAt: first.updatedAt + 1,
      }),
    ).rejects.toThrow(/inactive workspace/);

    // Even a corrupt same-id record in B must not leak through the strict
    // probe as a SyntaxError before the retained A handle is rejected.
    writeFileSync(
      path.join(canvasRoot('shared-id'), SPACE_JSON_FILENAME),
      '{broken',
      'utf8',
    );
    await expect(held.record.read()).rejects.toThrow(/inactive workspace/);
  });

  it('does not create a Space directory for a node write to a missing Space', () => {
    activateWorkspace('sediment-missing-node-space-');
    const handle = new DiskStructuredStore().space('missing-space');

    expect(handle.nodes.writeNode('n1', note('n1', 'Orphan'))).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(existsSync(canvasRoot('missing-space'))).toBe(false);
  });

  it('rejects an unreadable existing Space record instead of reporting not-found', () => {
    activateWorkspace('sediment-corrupt-node-space-');
    createSpace('canvas-a', 'Canvas A');
    const store = getCanvasStore('canvas-a');
    const root = canvasRoot('canvas-a');
    writeFileSync(path.join(root, SPACE_JSON_FILENAME), '{broken', 'utf8');

    expect(() => store.writeNode('n1', note('n1', 'Orphan'))).toThrow(
      /unreadable space\.json/,
    );
    expect(existsSync(path.join(root, 'nodes'))).toBe(false);
  });

  it.each(['write', 'delete'] as const)(
    'rejects a node %s when space.json is valid JSON with an invalid shape',
    (operation) => {
      activateWorkspace(`sediment-invalid-node-${operation}-`);
      createSpace('canvas-a', 'Canvas A');
      const store = getCanvasStore('canvas-a');
      const root = canvasRoot('canvas-a');
      const recordPath = path.join(root, SPACE_JSON_FILENAME);
      writeFileSync(recordPath, '{}', 'utf8');

      expect(() => {
        if (operation === 'write') {
          store.writeNode('n1', note('n1', 'Orphan'));
        } else {
          store.deleteNode('n1');
        }
      }).toThrow(/unreadable space\.json/);

      expect(readFileSync(recordPath, 'utf8')).toBe('{}');
      expect(existsSync(path.join(root, 'nodes'))).toBe(false);
    },
  );

  it('does not expose the wrapped CanvasStore as a runtime property', () => {
    activateWorkspace('sediment-node-wrapper-');
    createSpace('canvas-a', 'Canvas A');
    const nodes = new DiskStructuredStore().space('canvas-a').nodes;
    const runtime = nodes as unknown as Record<string, unknown>;

    expect(runtime['store']).toBeUndefined();
    expect(Object.getOwnPropertyNames(nodes)).not.toContain('store');
    expect(Object.keys(nodes)).toEqual([]);
  });
});
