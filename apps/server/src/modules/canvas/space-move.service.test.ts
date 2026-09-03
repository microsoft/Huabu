// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeOnServer } from './canvas-executor.js';
import { moveCanvasSelection } from './space-move.service.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { resetStorageCache, space } from '../storage/index.js';
import { getStructuredStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { SpaceMoveError } from './space-move.service.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'huabu-space-move-'));
  setWorkspacePath(workspace);
  resetStorageCache();
});

afterEach(() => {
  resetStorageCache();
  rmSync(workspace, { recursive: true, force: true });
});

async function seedSource() {
  createCanvas('source', 'Source');
  createCanvas('destination', 'Destination');
  return executeOnServer({
    canvasId: 'source',
    originator: { source: 'ui' },
    commands: [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-frame',
            nodeType: 'frame',
            data: { label: 'Frame' },
            position: { x: 20, y: 40 },
            size: { width: 400, height: 300 },
          },
          {
            id: 'node-child',
            nodeType: 'note',
            data: { label: 'Note', content: 'Hello' },
            position: { x: 30, y: 50 },
            parentId: 'node-frame',
            size: { width: 200, height: 100 },
          },
          {
            id: 'node-outside',
            nodeType: 'note',
            data: { label: 'Outside', content: 'Outside' },
            position: { x: 600, y: 40 },
            size: { width: 200, height: 100 },
          },
        ],
      },
      {
        type: 'CONNECT_NODES',
        edges: [
          {
            id: 'edge-boundary',
            source: 'node-child',
            target: 'node-outside',
          },
        ],
      },
    ],
  });
}

describe('moveCanvasSelection', () => {
  it('moves a Frame subtree and reports omitted boundary edges', async () => {
    const seeded = await seedSource();
    const sourceBefore = await space('source').read();
    const originalFrame = (
      sourceBefore?.state.nodes as Array<{
        id: string;
        position: { x: number; y: number };
      }>
    ).find((node) => node.id === 'node-frame');

    const result = await moveCanvasSelection('source', {
      selectedNodeIds: ['node-frame'],
      destination: { kind: 'existing', canvasId: 'destination' },
      createSourcePreview: true,
      expectedSourceVersion: seeded.toVersion,
    });

    expect(result).toMatchObject({
      movedNodeCount: 2,
      movedFrameCount: 1,
      preservedEdgeCount: 0,
      movedConversationCount: 0,
      destination: { created: false },
      omittedBoundaryEdges: [
        {
          edgeId: 'edge-boundary',
          source: 'node-child',
          target: 'node-outside',
        },
      ],
    });
    const source = await space('source').read();
    const destination = await space('destination').read();
    expect(source?.state.nodes).toHaveLength(2);
    expect(source?.state.nodes).toContainEqual(
      expect.objectContaining({
        id: result.sourcePreviewNodeId,
        type: 'spacePreview',
        position: originalFrame?.position,
        data: expect.objectContaining({ targetCanvasId: 'destination' }),
        style: expect.objectContaining({ width: 480, height: 320 }),
      }),
    );
    expect(destination?.state.nodes).toHaveLength(2);
    const child = (
      destination?.state.nodes as Array<{ parentId?: string }>
    ).find((node) => node.parentId);
    expect(child?.parentId).toBe(result.roots[0]?.destinationNodeId);
  });

  it('rejects a stale source version without changing either Space', async () => {
    await seedSource();

    await expect(
      moveCanvasSelection('source', {
        selectedNodeIds: ['node-frame'],
        destination: { kind: 'existing', canvasId: 'destination' },
        createSourcePreview: true,
        expectedSourceVersion: 0,
      }),
    ).rejects.toMatchObject({
      code: 'MOVE_SOURCE_STALE',
    } satisfies Partial<SpaceMoveError>);
    expect((await space('source').read())?.state.nodes).toHaveLength(3);
    expect((await space('destination').read())?.state.nodes).toHaveLength(0);
  });

  it('copies and rewrites required artifacts before deleting the source node', async () => {
    createCanvas('source', 'Source');
    createCanvas('destination', 'Destination');
    await space('source').blobs.put('artifact-old.png', Buffer.from('image'));
    const seeded = await executeOnServer({
      canvasId: 'source',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-image',
              nodeType: 'image',
              data: { label: 'Image', src: 'artifact-old.png' },
              position: { x: 0, y: 0 },
              size: { width: 100, height: 100 },
            },
          ],
        },
      ],
    });

    await moveCanvasSelection('source', {
      selectedNodeIds: ['node-image'],
      destination: { kind: 'existing', canvasId: 'destination' },
      createSourcePreview: true,
      expectedSourceVersion: seeded.toVersion,
    });

    const [record] = [...(await space('destination').nodes.list()).values()];
    expect(record?.record.src).toMatch(/^artifact-.+\.png$/);
    expect(record?.record.src).not.toBe('artifact-old.png');
    expect(
      await space('destination').blobs.read(record?.record.src ?? ''),
    ).toEqual(Buffer.from('image'));
    expect(await space('source').blobs.read('artifact-old.png')).toEqual(
      Buffer.from('image'),
    );
  });

  it('creates a named destination Space and leaves its preview at the source', async () => {
    createCanvas('source', 'Source');
    const seeded = await executeOnServer({
      canvasId: 'source',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-wide',
              nodeType: 'note',
              data: { label: 'Wide', content: 'body' },
              position: { x: 100, y: 200 },
              size: { width: 900, height: 700 },
            },
          ],
        },
      ],
    });

    const result = await moveCanvasSelection('source', {
      selectedNodeIds: ['node-wide'],
      destination: { kind: 'new', title: 'Moved work' },
      createSourcePreview: true,
      expectedSourceVersion: seeded.toVersion,
    });

    expect(result.destination).toMatchObject({
      title: 'Moved work',
      created: true,
    });
    expect(
      (await space(result.destination.canvasId).read())?.state.nodes,
    ).toHaveLength(1);
    expect((await space('source').read())?.state.nodes).toContainEqual(
      expect.objectContaining({
        id: result.sourcePreviewNodeId,
        type: 'spacePreview',
        position: { x: 100, y: 200 },
        style: expect.objectContaining({ width: 900, height: 700 }),
      }),
    );
  });

  it('removes a newly created destination when source validation fails', async () => {
    createCanvas('source', 'Source');

    await expect(
      moveCanvasSelection('source', {
        selectedNodeIds: ['missing'],
        destination: { kind: 'new', title: 'Temporary destination' },
        createSourcePreview: true,
        expectedSourceVersion: 0,
      }),
    ).rejects.toMatchObject({ code: 'MOVE_SOURCE_NODE_MISSING' });

    expect(
      (await getStructuredStore().spaces().list()).some(
        (candidate) => candidate.title === 'Temporary destination',
      ),
    ).toBe(false);
  });

  it('moves without leaving a source Preview when it is disabled', async () => {
    const seeded = await seedSource();

    const result = await moveCanvasSelection('source', {
      selectedNodeIds: ['node-frame'],
      destination: { kind: 'existing', canvasId: 'destination' },
      createSourcePreview: false,
      expectedSourceVersion: seeded.toVersion,
    });

    expect(result.sourcePreviewNodeId).toBeNull();
    expect((await space('source').read())?.state.nodes).toEqual([
      expect.objectContaining({ id: 'node-outside' }),
    ]);
    expect((await space('destination').read())?.state.nodes).toHaveLength(2);
  });
});
