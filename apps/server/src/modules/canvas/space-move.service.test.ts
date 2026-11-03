// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeOnServer } from './canvas-executor.js';
import * as canvasSync from './canvas-sync.js';
import { moveCanvasSelection } from './space-move.service.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { getCanvasStore, resetStorageCache, space } from '../storage/index.js';
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
  it.each([
    { mode: 'auto', height: undefined, expectedHeight: 424 },
    { mode: 'fixed', height: 172, expectedHeight: 172 },
  ])(
    'preserves a legacy $mode Note through persisted migration',
    async ({ mode, height, expectedHeight }) => {
      const source = createCanvas('source', 'Source');
      if (!source) throw new Error('Missing source Space');
      createCanvas('destination', 'Destination');
      const store = getCanvasStore('source');
      const autoHeight = { intrinsicHeight: 420, measuredFor: 'old' };
      store.write({
        ...source,
        state: {
          nodes: [
            {
              id: 'node-legacy',
              type: 'note',
              position: { x: 30, y: 40 },
              data: { label: 'Legacy', autoHeight },
              style: {
                width: 320,
                ...(height === undefined ? {} : { height }),
              },
            },
          ],
          edges: [],
        },
      });
      store.writeNode('node-legacy', {
        nodeId: 'node-legacy',
        type: 'note',
        label: 'Legacy',
        content: 'Keep this note.',
      });
      const result = await moveCanvasSelection('source', {
        selectedNodeIds: ['node-legacy'],
        destination: { kind: 'existing', canvasId: 'destination' },
        createSourcePreview: false,
        expectedSourceVersion: source.version,
      });
      const destinationId = result.roots[0]?.destinationNodeId;
      if (!destinationId) throw new Error('Missing moved Note');
      expect((await space('destination').read())?.state.nodes).toEqual([
        expect.objectContaining({
          id: destinationId,
          data: expect.objectContaining({ heightMode: mode, autoHeight }),
          style: { width: 320, height: expectedHeight },
        }),
      ]);
      expect((await space('source').read())?.state.nodes).toEqual([]);
      expect(
        getCanvasStore('destination').readNode(destinationId)?.content,
      ).toBe('Keep this note.');
    },
  );

  it('moves an unbound draft without manufacturing an execution record', async () => {
    createCanvas('source', 'Source');
    createCanvas('destination', 'Destination');
    const seeded = await executeOnServer({
      canvasId: 'source',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-draft',
              nodeType: 'question',
              position: { x: 0, y: 0 },
              data: {
                threadId: 'thread-draft',
                content: 'Draft',
                agentBinding: { kind: 'internal' },
              },
            },
          ],
        },
      ],
    });
    const result = await moveCanvasSelection('source', {
      selectedNodeIds: ['node-draft'],
      destination: { kind: 'existing', canvasId: 'destination' },
      createSourcePreview: false,
      expectedSourceVersion: seeded.toVersion,
    });
    const moved = (await space('destination').read())?.state.nodes[0] as {
      data: Record<string, unknown>;
    };
    expect(moved.data).toMatchObject({
      bindingState: 'editing',
      threadId: 'thread-draft',
    });
    expect(moved.data).not.toHaveProperty('invocationToken');
    expect(result.movedNodeCount).toBe(1);
  });

  it('does not wait for turn admission while holding both Canvas locks', async () => {
    createCanvas('source', 'Source');
    createCanvas('destination', 'Destination');
    const seeded = await executeOnServer({
      canvasId: 'source',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-busy',
              nodeType: 'question',
              position: { x: 0, y: 0 },
              data: {
                threadId: 'thread-busy',
                content: '',
                agentBinding: { kind: 'internal' },
              },
            },
          ],
        },
      ],
    });
    const release = acquireAgentTurn('thread-busy');
    expect(release).not.toBeNull();
    try {
      await expect(
        moveCanvasSelection('source', {
          selectedNodeIds: ['node-busy'],
          destination: { kind: 'existing', canvasId: 'destination' },
          createSourcePreview: false,
          expectedSourceVersion: seeded.toVersion,
        }),
      ).rejects.toMatchObject({ code: 'MOVE_AGENT_RUNNING' });
      const edited = await executeOnServer({
        canvasId: 'source',
        originator: { source: 'ui' },
        commands: [
          {
            type: 'SET_NODE_GEOMETRY',
            items: [{ nodeId: 'node-busy', position: { x: 20, y: 20 } }],
          },
        ],
      });
      expect(edited.results[0]?.applied).toBe(true);
    } finally {
      release?.();
    }
  });

  it('compensates both committed Spaces without retaining the source breadcrumb', async () => {
    const seeded = await seedSource();
    const sourceBefore = (await space('source').read())!;
    const destinationBefore = (await space('destination').read())!;
    const failure = new Error('Injected post-commit publication failure');
    const publish = vi
      .spyOn(canvasSync, 'publishCanvasUpdate')
      .mockImplementationOnce(() => {
        expect(getCanvasStore('source').read()?.state.nodes).toContainEqual(
          expect.objectContaining({ type: 'spacePreview' }),
        );
        expect(getCanvasStore('destination').read()?.state.nodes).toHaveLength(
          2,
        );
        throw failure;
      });
    try {
      await expect(
        moveCanvasSelection('source', {
          selectedNodeIds: ['node-frame'],
          destination: { kind: 'existing', canvasId: 'destination' },
          createSourcePreview: true,
          expectedSourceVersion: seeded.toVersion,
        }),
      ).rejects.toMatchObject({ code: 'MOVE_FAILED', cause: failure });
      expect(publish).toHaveBeenCalledTimes(1);

      const source = (await space('source').read())!;
      const destination = (await space('destination').read())!;
      expect(source.state.nodes).toHaveLength(sourceBefore.state.nodes.length);
      expect(source.state.nodes).toEqual(
        expect.arrayContaining(sourceBefore.state.nodes),
      );
      expect(source.state.edges).toEqual(sourceBefore.state.edges);
      expect(destination.state).toEqual(destinationBefore.state);
      expect(getCanvasStore('source').readNode('node-child')?.content).toBe(
        'Hello',
      );
      expect((await space('destination').nodes.list()).size).toBe(0);
      for (const [canvasId, before] of [
        ['source', sourceBefore],
        ['destination', destinationBefore],
      ] as const) {
        const log = getCanvasStore(canvasId).readDeltaLogSince(before.version);
        expect(log).toHaveLength(2);
        expect(log[1]).toMatchObject({
          version: before.version + 2,
          commands: [],
          originator: { source: 'system' },
        });
      }
    } finally {
      publish.mockRestore();
    }
  });

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
        style: { width: 400 },
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
    await space('source').artifacts.put(
      'artifact-old.png',
      Buffer.from('image'),
    );
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
      await space('destination').artifacts.read(record?.record.src ?? ''),
    ).toEqual(Buffer.from('image'));
    expect(await space('source').artifacts.read('artifact-old.png')).toEqual(
      Buffer.from('image'),
    );
  });

  it('refuses to copy an artifact cited from a Space the caller may not read', async () => {
    createCanvas('source', 'Source');
    createCanvas('destination', 'Destination');
    createCanvas('private', 'Private');
    await space('private').artifacts.put(
      'artifact-secret.png',
      Buffer.from('x'),
    );
    const seeded = await executeOnServer({
      canvasId: 'source',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-cited',
              nodeType: 'image',
              data: {
                label: 'Cited',
                src: '/api/canvas/private/artifact/artifact-secret.png',
              },
              position: { x: 0, y: 0 },
              size: { width: 100, height: 100 },
            },
          ],
        },
      ],
    });
    const move = (canRead: boolean) =>
      moveCanvasSelection(
        'source',
        {
          selectedNodeIds: ['node-cited'],
          destination: { kind: 'existing', canvasId: 'destination' },
          createSourcePreview: false,
          expectedSourceVersion: seeded.toVersion,
        },
        {
          canRead: async () => canRead,
          canManage: async () => true,
          claim: async () => {},
        },
      );

    await expect(move(false)).rejects.toMatchObject({
      code: 'MOVE_ARTIFACT_MISSING',
    });
    expect((await space('destination').nodes.list()).size).toBe(0);
    expect((await space('source').read())?.state.nodes).toHaveLength(1);
    await move(true);
    expect((await space('destination').nodes.list()).size).toBe(1);
  });

  it('claims a new destination before moving content, and keeps the source when that fails', async () => {
    createCanvas('source', 'Source');
    const seeded = await executeOnServer({
      canvasId: 'source',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-claimed',
              nodeType: 'note',
              data: { label: 'Claimed', content: 'body' },
              position: { x: 0, y: 0 },
              size: { width: 200, height: 100 },
            },
          ],
        },
      ],
    });
    const move = (claim: (canvasId: string) => Promise<void>) =>
      moveCanvasSelection(
        'source',
        {
          selectedNodeIds: ['node-claimed'],
          destination: { kind: 'new', title: 'Claimed destination' },
          createSourcePreview: false,
          expectedSourceVersion: seeded.toVersion,
        },
        { canRead: async () => true, canManage: async () => true, claim },
      );

    await expect(
      move(async () => {
        throw new Error('grant store unavailable');
      }),
    ).rejects.toBeInstanceOf(Error);
    expect((await space('source').read())?.state.nodes).toHaveLength(1);
    expect(
      (await getStructuredStore().spaces().list()).some(
        (candidate) => candidate.title === 'Claimed destination',
      ),
    ).toBe(false);

    const claimed: Array<[string, number]> = [];
    const result = await move(async (canvasId) => {
      claimed.push([
        canvasId,
        (await space('source').read())!.state.nodes.length,
      ]);
    });
    // Claimed while the selection was still in the source.
    expect(claimed).toEqual([[result.destination.canvasId, 1]]);
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
        style: { width: 400 },
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
