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

import { measuredSizeKey } from '@huabu/shared/canvas-engine';

import { executeOnServer } from './canvas-executor.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

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
  store.writeNode('frame', {
    nodeId: 'frame',
    type: 'frame',
    label: 'Frame',
    content: '',
  });
  store.writeNode('note', {
    nodeId: 'note',
    type: 'note',
    label: 'Kept',
    content: '# The body',
  });
  store.writeNode('other', {
    nodeId: 'other',
    type: 'note',
    label: 'Other',
    content: '',
  });
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
    expect(node?.data).toEqual({
      type: 'note',
      heightMode: 'fixed',
      paintKey: expect.any(String),
    });
  });
});

describe('APPLY_MEASURED_SIZE on the server', () => {
  const textNode = {
    id: 'text',
    type: 'text',
    position: { x: 20, y: 60 },
    style: { width: 200 },
    data: { type: 'text', content: 'A line' },
  };
  const key = measuredSizeKey(textNode as unknown as CanvasNode);

  beforeEach(async () => {
    await run([
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'hug',
            nodeType: 'frame',
            position: { x: 1000, y: 1000 },
            size: { width: 300, height: 200 },
            data: { sizing: 'hug' },
          },
        ],
      },
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'text',
            nodeType: 'text',
            parentId: 'hug',
            position: { x: 20, y: 60 },
            size: { width: 200 },
            data: { content: 'A line' },
          },
        ],
      },
    ]);
  });

  it('stores the reported box and lays the Frame out around it', async () => {
    const first = await run([
      {
        type: 'APPLY_MEASURED_SIZE',
        items: [{ nodeId: 'text', width: 200, height: 40, measuredFor: key }],
      },
    ]);
    expect(first.results[0].applied).toBe(true);
    const frameHeight = () =>
      (
        stored().nodes.find((node) => node.id === 'hug')?.style as {
          height: number;
        }
      ).height;
    const fitted = frameHeight();

    const grown = await run([
      {
        type: 'APPLY_MEASURED_SIZE',
        items: [{ nodeId: 'text', width: 200, height: 340, measuredFor: key }],
      },
    ]);
    expect(grown.toVersion).toBe(grown.fromVersion + 1);
    expect(frameHeight()).toBe(fitted + 300);
    expect(stored().nodes.find((node) => node.id === 'text')).toMatchObject({
      measured: { width: 200, height: 340 },
      data: { measuredSize: { width: 200, height: 340, measuredFor: key } },
    });
  });

  it('writes nothing for a measurement of content the Space no longer has', async () => {
    await run([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'text', patch: { content: 'Two\nlines now' } }],
      },
    ]);
    const out = await run([
      {
        type: 'APPLY_MEASURED_SIZE',
        items: [{ nodeId: 'text', width: 200, height: 340, measuredFor: key }],
      },
    ]);
    expect(out.results[0]).toMatchObject({ applied: false, reason: 'no-op' });
    expect(out.toVersion).toBe(out.fromVersion);
    expect(
      stored().nodes.find((node) => node.id === 'text')?.data,
    ).not.toHaveProperty('measuredSize');
  });

  it('writes nothing when the same box is reported again', async () => {
    const item = { nodeId: 'text', width: 200, height: 40, measuredFor: key };
    await run([{ type: 'APPLY_MEASURED_SIZE', items: [item] }]);
    const again = await run([{ type: 'APPLY_MEASURED_SIZE', items: [item] }]);
    expect(again.toVersion).toBe(again.fromVersion);
  });
});

describe('a command that changes a node keeps what only the server derives for it', () => {
  // A video's cover and a web page's saved snapshot live in the node record
  // alone: no page holds them, so the node a command hands back does not
  // either. Writing the record from that node must not drop them.
  beforeEach(() => {
    const store = getCanvasStore(CANVAS);
    const canvas = store.read();
    if (!canvas) throw new Error('Space missing');
    store.write({
      ...canvas,
      state: {
        ...canvas.state,
        nodes: [
          ...(canvas.state.nodes as CanvasNode[]),
          {
            id: 'video',
            type: 'video',
            position: { x: 0, y: 900 },
            data: { type: 'video' },
          },
          {
            id: 'web',
            type: 'web',
            position: { x: 400, y: 900 },
            data: { type: 'web' },
          },
        ],
      },
    });
    store.writeNode('video', {
      nodeId: 'video',
      type: 'video',
      label: 'Clip',
      content: '',
      src: 'clip.webm',
      coverUrl: 'cover_1.jpg',
      coverSourceSrc: 'clip.webm',
    } as never);
    store.writeNode('web', {
      nodeId: 'web',
      type: 'web',
      label: 'Page',
      content: 'Extracted body',
      src: 'https://example.com/',
      mhtmlArtifact: 'artifact-1.mhtml',
      summary: 'A summary',
    } as never);
  });

  it.each(['ui', 'agent'] as const)(
    'when a %s batch recolours and renames them',
    async (source) => {
      const out = await run(
        [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              { nodeId: 'video', patch: { style: { accent: 'red' } } },
              { nodeId: 'web', patch: { label: 'Renamed page' } },
            ],
          },
        ],
        source,
      );
      expect(out.results[0].applied).toBe(true);

      const store = getCanvasStore(CANVAS);
      expect(store.readNode('video')).toMatchObject({
        label: 'Clip',
        src: 'clip.webm',
        coverUrl: 'cover_1.jpg',
        coverSourceSrc: 'clip.webm',
      });
      expect(store.readNode('web')).toMatchObject({
        label: 'Renamed page',
        content: 'Extracted body',
        mhtmlArtifact: 'artifact-1.mhtml',
        summary: 'A summary',
      });
    },
  );

  it('does not keep them beside another source', async () => {
    await run([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          { nodeId: 'web', patch: { src: 'https://example.com/other' } },
        ],
      },
    ]);
    const record = getCanvasStore(CANVAS).readNode('web');
    expect(record).toMatchObject({ src: 'https://example.com/other' });
    // The saved snapshot was of the page the node pointed at before; kept,
    // it would pass for the new page's and the new page would not be read.
    expect(record).not.toHaveProperty('mhtmlArtifact');
  });

  it('does not hand them to a node recreated under the same id', async () => {
    await run([{ type: 'DELETE_NODES', nodeIds: ['video'] }]);
    await run([
      {
        type: 'RESTORE_NODES',
        nodes: [
          {
            id: 'video',
            type: 'video',
            position: { x: 0, y: 900 },
            data: { type: 'video', label: 'Clip', src: 'other.webm' },
          },
        ],
      },
    ]);
    const record = getCanvasStore(CANVAS).readNode('video');
    expect(record).toMatchObject({ src: 'other.webm' });
    expect(record).not.toHaveProperty('coverUrl');
  });
});
