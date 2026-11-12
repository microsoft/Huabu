// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A page's undo through the headless executor: `RESTORE_NODES` puts a
 * deleted node back with its id and its stored content, and an explicit
 * `unset` removes a data key. Disk backend.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeOnServer } from './canvas-executor.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand } from '@huabu/shared';

let tmp: string;
const originalDataDir = process.env.HUABU_DATA_DIR;
const CANVAS = 'canvas-restore';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-restore-'));
  process.env.HUABU_DATA_DIR = tmp;
  setWorkspacePath(tmp);
  const store = getCanvasStore(CANVAS);
  store.write({
    canvasId: CANVAS,
    title: null,
    version: 1,
    state: {
      nodes: [
        {
          id: 'frame',
          type: 'frame',
          position: { x: 0, y: 0 },
          style: { width: 500, height: 400 },
          data: { type: 'frame', sizing: 'manual' },
        },
        {
          id: 'note',
          type: 'note',
          parentId: 'frame',
          position: { x: 40, y: 60 },
          style: { width: 240, height: 120 },
          data: { type: 'note', heightMode: 'fixed', pinned: true },
        },
        { id: 'other', type: 'note', position: { x: 900, y: 0 }, data: {} },
      ],
      edges: [{ id: 'edge', source: 'note', target: 'other' }],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode('frame', { nodeId: 'frame', type: 'frame', label: 'Frame' });
  store.writeNode('note', {
    nodeId: 'note',
    type: 'note',
    label: 'Kept',
    content: '# The body',
  });
  store.writeNode('other', { nodeId: 'other', type: 'note', label: 'Other' });
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = originalDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

function run(commands: unknown[], source: 'ui' | 'agent' = 'ui') {
  return executeOnServer({
    canvasId: CANVAS,
    originator: { source },
    commands: commands as CanvasCommand[],
  });
}

function stored() {
  const canvas = getCanvasStore(CANVAS).read();
  if (!canvas) throw new Error('Space missing');
  return canvas.state as {
    nodes: Array<Record<string, unknown> & { id: string }>;
    edges: Array<{ id: string }>;
  };
}

const snapshot = {
  id: 'note',
  type: 'note',
  parentId: 'frame',
  position: { x: 40, y: 60 },
  style: { width: 240, height: 120 },
  data: {
    type: 'note',
    heightMode: 'fixed',
    pinned: true,
    label: 'Kept',
    content: '# The body',
  },
};

describe('RESTORE_NODES on the server', () => {
  it('brings a deleted node back with its id, place, edge and content', async () => {
    const removed = await run([{ type: 'DELETE_NODES', nodeIds: ['note'] }]);
    expect(removed.results[0].applied).toBe(true);
    expect(getCanvasStore(CANVAS).readNode('note')).toBeNull();
    expect(stored().edges).toEqual([]);

    const restored = await run([
      {
        type: 'RESTORE_NODES',
        nodes: [snapshot],
        edges: [{ id: 'edge', source: 'note', target: 'other' }],
      },
    ]);
    expect(restored.results[0].applied).toBe(true);
    expect(restored.toVersion).toBe(removed.toVersion + 1);
    expect(restored.deltas.map((delta) => delta.type).sort()).toEqual([
      'INSERT_EDGE',
      'INSERT_NODE',
    ]);

    const state = stored();
    const node = state.nodes.find((candidate) => candidate.id === 'note');
    expect(node).toMatchObject({
      parentId: 'frame',
      position: { x: 40, y: 60 },
      style: { width: 240, height: 120 },
      data: { heightMode: 'fixed', pinned: true },
    });
    // Content lives in the sidecar, not in the structure record.
    expect(node?.data).not.toHaveProperty('content');
    expect(getCanvasStore(CANVAS).readNode('note')).toMatchObject({
      label: 'Kept',
      content: '# The body',
    });
    expect(state.edges.map((edge) => edge.id)).toEqual(['edge']);
    // The manual Frame was not fitted around the node.
    expect(
      state.nodes.find((candidate) => candidate.id === 'frame')?.style,
    ).toEqual({ width: 500, height: 400 });
  });

  it('refuses an id that is still on the Space and writes nothing', async () => {
    const out = await run([{ type: 'RESTORE_NODES', nodes: [snapshot] }]);
    expect(out.results[0]).toMatchObject({
      applied: false,
      reason: 'duplicate-id',
    });
    expect(out.toVersion).toBe(out.fromVersion);
    expect(getCanvasStore(CANVAS).readNode('note')).toMatchObject({
      content: '# The body',
    });
  });

  it('refuses a node whose parent is gone', async () => {
    await run([{ type: 'DELETE_NODES', nodeIds: ['frame'] }]);
    const out = await run([{ type: 'RESTORE_NODES', nodes: [snapshot] }]);
    expect(out.results[0]).toMatchObject({
      applied: false,
      reason: 'invalid-parent',
    });
    expect(stored().nodes.map((node) => node.id)).toEqual(['other']);
  });

  it('is refused for an agent batch', async () => {
    await run([{ type: 'DELETE_NODES', nodeIds: ['note'] }]);
    const out = await run(
      [{ type: 'RESTORE_NODES', nodes: [snapshot] }],
      'agent',
    );
    expect(out.results[0]).toMatchObject({
      applied: false,
      reason: 'invalid-scope',
    });
    expect(stored().nodes.some((node) => node.id === 'note')).toBe(false);
  });

  it('replaces a node in place without rewriting its stored content', async () => {
    const out = await run([
      {
        type: 'RESTORE_NODES',
        nodes: [
          {
            ...snapshot,
            position: { x: 1, y: 2 },
            data: { type: 'note', heightMode: 'auto', content: 'stale body' },
          },
        ],
        replace: ['note'],
        keepDataKeys: ['content', 'label'],
      },
    ]);
    expect(out.results[0].applied).toBe(true);
    const node = stored().nodes.find((candidate) => candidate.id === 'note');
    expect(node).toMatchObject({
      position: { x: 1, y: 2 },
      data: { heightMode: 'auto' },
    });
    expect(node?.data).not.toHaveProperty('pinned');
    expect(getCanvasStore(CANVAS).readNode('note')).toMatchObject({
      label: 'Kept',
      content: '# The body',
    });
  });
});

describe('MERGE_NODE_DATA unset on the server', () => {
  it('removes the key from the stored node', async () => {
    const out = await run([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'note', patch: {}, unset: ['pinned'] }],
      },
    ]);
    expect(out.results[0].applied).toBe(true);
    expect(out.toVersion).toBe(out.fromVersion + 1);
    const node = stored().nodes.find((candidate) => candidate.id === 'note');
    expect(node?.data).toEqual({ type: 'note', heightMode: 'fixed' });
  });
});
