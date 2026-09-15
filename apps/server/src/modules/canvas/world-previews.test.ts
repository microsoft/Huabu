// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMMAND_META,
  extractCanvasChanges,
  invertDelta,
} from '@huabu/shared/canvas-engine';

const workspaceState = vi.hoisted(() => ({ path: '' }));
vi.mock('../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
  getWorkspaceKey: () => workspaceState.path,
}));

import * as canvasExecutor from './canvas-executor.js';
import { applyDeltasOnServer, executeOnServer } from './canvas-executor.js';
import canvasRoutes from './canvas.route.js';
import {
  assertCurrentCanvasCommands,
  assertCurrentCanvasNodeTypes,
  assertWorldPreviewTopologyAllowed,
  WorldPreviewMutationError,
} from './world-preview-policy.js';
import {
  reconcileWorldPreviews,
  WorldPreviewIntegrityError,
} from './world-previews.js';
import { refreshCanvasDirIndex } from '../storage/canvas-dirs.js';
import { getCanvasStore, space } from '../storage/index.js';

import type {
  CanvasCommand,
  CanvasNodeId,
  ExecuteOriginator,
} from '@huabu/shared';
import type { Delta } from '@huabu/shared/canvas-engine';

interface TestNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  parentId?: string;
  style?: { width: number; height: number };
  data: Record<string, unknown>;
}

function preview(id = 'node-preview', targetCanvasId = 'canvas-a'): TestNode {
  return {
    id,
    type: 'spacePreview',
    position: { x: 100, y: 200 },
    style: { width: 720, height: 460 },
    data: { targetCanvasId },
  };
}

function writeCanvas(
  directory: string,
  canvasId: string,
  nodes: unknown[] = [],
  edges: unknown[] = [],
): void {
  const root = path.join(workspaceState.path, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'space.json'),
    JSON.stringify({
      canvasId,
      title: directory,
      version: 0,
      state: { nodes, edges },
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  refreshCanvasDirIndex();
}

async function previews(): Promise<TestNode[]> {
  return (
    (await space('canvas-world').read())?.state.nodes as TestNode[]
  ).filter((node) => node.type === 'spacePreview');
}

/** Include sidecars, logs, and review records, not just projected topology. */
function diskSnapshot(directory = workspaceState.path): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, diskSnapshot(filename));
    else files[filename] = readFileSync(filename).toString('base64');
  }
  return files;
}

async function expectRejectedWithoutWrites(
  canvasId: string,
  deltas: Delta[],
  source: ExecuteOriginator['source'],
): Promise<void> {
  const store = getCanvasStore(canvasId);
  const spies = [
    vi.spyOn(store, 'write'),
    vi.spyOn(store, 'writeNode'),
    vi.spyOn(store, 'deleteNode'),
    vi.spyOn(store, 'appendDeltaLogEntry'),
  ];
  const before = diskSnapshot();
  try {
    await expect(
      applyDeltasOnServer({ canvasId, deltas, originator: { source } }),
    ).rejects.toBeInstanceOf(WorldPreviewMutationError);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(diskSnapshot()).toEqual(before);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

beforeEach(() => {
  workspaceState.path = mkdtempSync(
    path.join(tmpdir(), 'huabu-world-previews-'),
  );
  writeCanvas('.world', 'canvas-world', [
    {
      id: 'node-note',
      type: 'note',
      position: { x: 0, y: 0 },
      style: { width: 200, height: 100 },
      data: {},
    },
  ]);
  writeCanvas('Project A', 'canvas-a');
  writeCanvas('Project B', 'canvas-b');
});

afterEach(() => rmSync(workspaceState.path, { recursive: true, force: true }));

describe('Delta replay policy before persistence', () => {
  it.each([
    ['future-invalid', 'canvas-a', 'ui', 'INSERT_NODE', 'top-level'],
    ['future-invalid', 'canvas-world', 'agent', 'REPLACE_NODE', 'data'],
    ['canvasRef', 'canvas-world', 'system', 'INSERT_NODE', 'top-level'],
    ['nodeRef', 'canvas-a', 'system', 'REPLACE_NODE', 'data'],
  ] as const)(
    'rejects unsupported %s on %s from %s via %s %s without writes',
    async (type, canvasId, source, operation, discriminator) => {
      const note = {
        ...preview('node-note'),
        type: 'note',
        data: { label: 'Note' },
      };
      writeCanvas(
        canvasId === 'canvas-world' ? '.world' : 'Project A',
        canvasId,
        [note],
      );
      getCanvasStore(canvasId).writeNode(note.id, {
        nodeId: note.id,
        type: 'note',
        label: 'Note',
        content: 'Original body',
      });
      const unsupported = {
        ...note,
        id: operation === 'INSERT_NODE' ? 'node-unsupported' : note.id,
        ...(discriminator === 'top-level' ? { type } : { data: { type } }),
      };
      const delta: Delta =
        operation === 'INSERT_NODE'
          ? { type: operation, node: unsupported }
          : { type: operation, prev: note, next: unsupported };
      // A valid content edit earlier in the same batch must not leak to disk.
      await expectRejectedWithoutWrites(
        canvasId,
        [
          {
            type: 'REPLACE_NODE',
            prev: note,
            next: {
              ...note,
              data: { label: 'Note', content: 'Must not persist' },
            },
          },
          delta,
        ],
        source,
      );
    },
  );

  it.each(['ui', 'agent', 'system'] as const)(
    'rejects live preview deletion, repointing, and type replacement for %s',
    async (source) => {
      const current = preview();
      writeCanvas('.world', 'canvas-world', [current]);
      for (const delta of [
        { type: 'DELETE_NODE', node: current },
        {
          type: 'REPLACE_NODE',
          prev: current,
          next: preview(current.id, 'canvas-b'),
        },
        {
          type: 'REPLACE_NODE',
          prev: current,
          next: { ...current, type: 'note' },
        },
        { type: 'INSERT_NODE', node: preview(current.id, 'canvas-b') },
      ] satisfies Delta[]) {
        await expectRejectedWithoutWrites('canvas-world', [delta], source);
      }
    },
  );

  it.each(['ui', 'agent'] as const)(
    'rejects unauthorized preview creation by %s even for a unique live target',
    async (source) => {
      writeCanvas('.world', 'canvas-world', [preview()]);
      await expectRejectedWithoutWrites(
        'canvas-world',
        [{ type: 'INSERT_NODE', node: preview('node-new', 'canvas-b') }],
        source,
      );
    },
  );

  it('keeps system preview creation subject to identity integrity checks', async () => {
    const current = preview();
    writeCanvas('.world', 'canvas-world', [current]);
    for (const node of [
      preview('node-duplicate'),
      preview('node-malformed', ''),
    ]) {
      await expectRejectedWithoutWrites(
        'canvas-world',
        [{ type: 'INSERT_NODE', node }],
        'system',
      );
    }
    const out = await applyDeltasOnServer({
      canvasId: 'canvas-world',
      deltas: [{ type: 'INSERT_NODE', node: preview('node-new', 'canvas-b') }],
      originator: { source: 'system' },
    });
    expect(out.toVersion).toBe(1);
    expect(await previews()).toEqual([
      current,
      preview('node-new', 'canvas-b'),
    ]);
  });

  it.each(['ui', 'agent', 'system'] as const)(
    'allows preview geometry and parenting reverts for %s',
    async (source) => {
      const current = preview();
      const frame = { ...preview('node-frame'), type: 'frame', data: {} };
      writeCanvas('.world', 'canvas-world', [frame, current]);
      const next = {
        ...current,
        parentId: frame.id,
        position: { x: 15, y: 25 },
        style: { width: 900, height: 700 },
      };
      const out = await applyDeltasOnServer({
        canvasId: 'canvas-world',
        deltas: [{ type: 'REPLACE_NODE', prev: current, next }],
        originator: { source },
      });
      expect(out.toVersion).toBe(1);
      expect(await previews()).toEqual([next]);
    },
  );

  it('allows deleting a missing-target World preview', async () => {
    const current = preview('node-missing', 'canvas-gone');
    writeCanvas('.world', 'canvas-world', [current]);
    const out = await applyDeltasOnServer({
      canvasId: 'canvas-world',
      deltas: [{ type: 'DELETE_NODE', node: current }],
      originator: { source: 'ui' },
    });
    expect(out.toVersion).toBe(1);
    expect(await previews()).toEqual([]);
  });

  it.each(['ui', 'system'] as const)(
    'restores ordinary content and edges and removes a Move breadcrumb for %s',
    async (source) => {
      const breadcrumb = preview('node-breadcrumb', 'canvas-b');
      writeCanvas('Project A', 'canvas-a', [breadcrumb]);
      const note = {
        ...preview('node-restored'),
        type: 'note',
        data: { label: 'Restored', content: 'Restored body' },
      };
      const peer = {
        ...note,
        id: 'node-peer',
        data: { label: 'Peer', content: 'Peer body' },
      };
      const edge = { id: 'edge-restored', source: note.id, target: peer.id };
      const out = await applyDeltasOnServer({
        canvasId: 'canvas-a',
        originator: { source },
        deltas: [
          { type: 'DELETE_NODE', node: breadcrumb },
          { type: 'INSERT_NODE', node: note },
          { type: 'INSERT_NODE', node: peer },
          { type: 'INSERT_EDGE', edge },
        ],
      });
      expect(out.toVersion).toBe(1);
      expect(getCanvasStore('canvas-a').readNode(note.id)?.content).toBe(
        'Restored body',
      );
      expect((await space('canvas-a').read())?.state).toMatchObject({
        nodes: [
          expect.objectContaining({ id: note.id }),
          expect.objectContaining({ id: peer.id }),
        ],
        edges: [edge],
      });
      expect(getCanvasStore('canvas-a').readDeltaLogSince(0)).toHaveLength(1);
    },
  );
});

describe('Rejected public reverts retain review records', () => {
  it.each(['legacy', 'delete', 'repoint', 'create'])(
    'returns 409 without writes for a %s revert',
    async (operation) => {
      const current = preview();
      writeCanvas('.world', 'canvas-world', [current]);
      const delta: Delta =
        operation === 'delete'
          ? { type: 'DELETE_NODE', node: current }
          : operation === 'repoint'
            ? {
                type: 'REPLACE_NODE',
                prev: current,
                next: preview(current.id, 'canvas-b'),
              }
            : {
                type: 'INSERT_NODE',
                node:
                  operation === 'legacy'
                    ? { ...preview('node-legacy'), type: 'canvasRef' }
                    : preview('node-new', 'canvas-b'),
              };
      const [record] = extractCanvasChanges([invertDelta(delta)]);
      const handle = space('canvas-world');
      const records = await handle.changes.append('thread-review', [record]);
      const app = Fastify();
      await app.register(canvasRoutes, { prefix: '/canvas' });
      const before = diskSnapshot();
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/canvas/canvas-world/threads/thread-review/changes/${records[0].id}/revert`,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ message: expect.any(String) });
        expect(await handle.changes.read('thread-review')).toEqual(records);
        expect(diskSnapshot()).toEqual(before);
      } finally {
        await app.close();
      }
    },
  );
});

describe('World preview reconciliation', () => {
  it('accepts a stale-preview DELETE already completed between planning and execution', async () => {
    await reconcileWorldPreviews();
    rmSync(path.join(workspaceState.path, 'Project B'), { recursive: true });
    refreshCanvasDirIndex();
    const execute = canvasExecutor.executeOnServer;
    const spy = vi
      .spyOn(canvasExecutor, 'executeOnServer')
      .mockImplementationOnce(async (input) => {
        expect(input.commands).toEqual([
          { type: 'DELETE_NODES', nodeIds: [expect.any(String)] },
        ]);
        // A concurrent writer wins the deletion; the original batch now no-ops.
        await execute(input);
        const result = await execute(input);
        expect(result.results.some((entry) => !entry.applied)).toBe(true);
        return result;
      });
    try {
      await expect(reconcileWorldPreviews()).resolves.toBeUndefined();
      expect(
        (await previews()).map((node) => node.data.targetCanvasId),
      ).toEqual(['canvas-a']);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('still rejects unapplied work when the fresh state needs reconciliation', async () => {
    const execute = canvasExecutor.executeOnServer;
    const spy = vi
      .spyOn(canvasExecutor, 'executeOnServer')
      .mockImplementationOnce(async (input) => {
        const result = await execute({ ...input, commands: [] });
        return {
          ...result,
          results: input.commands.map((command) => ({
            command,
            applied: false,
          })),
        };
      });
    try {
      await expect(reconcileWorldPreviews()).rejects.toBeInstanceOf(
        WorldPreviewIntegrityError,
      );
      expect(await previews()).toEqual([]);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
    // A failed attempt does not poison the existing reconciliation queue.
    await expect(reconcileWorldPreviews()).resolves.toBeUndefined();
    expect(await previews()).toHaveLength(2);
  });

  it('does not swallow an executor exception', async () => {
    const spy = vi
      .spyOn(canvasExecutor, 'executeOnServer')
      .mockRejectedValueOnce(new Error('Storage unavailable'));
    try {
      await expect(reconcileWorldPreviews()).rejects.toThrow(
        'Storage unavailable',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('creates one deterministic preview per live Space and is idempotent', async () => {
    await reconcileWorldPreviews();
    expect(
      (await previews()).map((node) => ({
        target: node.data.targetCanvasId,
        position: node.position,
      })),
    ).toEqual([
      { target: 'canvas-a', position: { x: 560, y: 0 } },
      { target: 'canvas-b', position: { x: 1120, y: 0 } },
    ]);
    const first = await space('canvas-world').read();
    await reconcileWorldPreviews();
    expect(await space('canvas-world').read()).toEqual(first);
  });

  it('preserves preview identity and geometry and removes only deleted targets', async () => {
    const existing = preview();
    writeCanvas('.world', 'canvas-world', [existing]);
    await reconcileWorldPreviews();
    rmSync(path.join(workspaceState.path, 'Project B'), { recursive: true });
    writeCanvas('Project C', 'canvas-c');
    await reconcileWorldPreviews();
    expect(await previews()).toContainEqual(existing);
    expect(
      (await previews()).map((node) => node.data.targetCanvasId).sort(),
    ).toEqual(['canvas-a', 'canvas-c']);
  });

  it('ignores legacy topology on read without rewriting disk and never reuses its identity or geometry', async () => {
    writeCanvas(
      '.world',
      'canvas-world',
      [
        { ...preview('node-old'), type: 'canvasRef' },
        {
          id: 'node-pin',
          type: 'frameRef',
          parentId: 'node-old',
          position: { x: 10, y: 20 },
          data: {},
        },
        {
          id: 'node-child',
          type: 'note',
          parentId: 'node-pin',
          position: { x: 3, y: 4 },
          data: {},
        },
        { id: 'node-ref', type: 'nodeRef', position: { x: 0, y: 0 }, data: {} },
      ],
      [{ id: 'edge-old', source: 'node-old', target: 'node-child' }],
    );
    const filename = path.join(workspaceState.path, '.world', 'space.json');
    const before = readFileSync(filename, 'utf8');
    const loaded = await space('canvas-world').read();
    expect(loaded?.state.nodes).toEqual([
      {
        id: 'node-child',
        type: 'note',
        position: { x: 113, y: 224 },
        data: {},
      },
    ]);
    expect(loaded?.state.edges).toEqual([]);
    expect(readFileSync(filename, 'utf8')).toBe(before);
    await reconcileWorldPreviews();
    const current = await previews();
    expect(current).toHaveLength(2);
    expect(current.every((node) => node.id !== 'node-old')).toBe(true);
    expect(current[0]?.style).toMatchObject({ width: 480, height: 320 });
    expect(getCanvasStore('canvas-world').read()?.state.nodes).not.toEqual(
      JSON.parse(before).state.nodes,
    );
  });

  it.each(['duplicate', 'malformed'])(
    'rejects %s managed identities',
    async (kind) => {
      writeCanvas(
        '.world',
        'canvas-world',
        kind === 'duplicate'
          ? [preview(), preview('node-copy')]
          : [{ ...preview(), data: {} }],
      );
      await expect(reconcileWorldPreviews()).rejects.toBeInstanceOf(
        WorldPreviewIntegrityError,
      );
    },
  );
});

describe('World preview ownership', () => {
  beforeEach(() => writeCanvas('.world', 'canvas-world', [preview()]));

  it.each(['ui', 'agent'] as const)(
    'rejects managed creation, deletion, repointing, and type change from %s',
    async (source) => {
      const commands: CanvasCommand[] = [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'spacePreview',
              position: { x: 0, y: 0 },
              data: { targetCanvasId: 'canvas-b' },
            },
          ],
        },
        { type: 'DELETE_NODES', nodeIds: ['node-preview' as CanvasNodeId] },
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId: 'node-preview' as CanvasNodeId,
              patch: { targetCanvasId: 'canvas-b' },
            },
          ],
        },
        {
          type: 'CHANGE_NODE_TYPE',
          nodeId: 'node-preview' as CanvasNodeId,
          to: 'note',
        },
      ];
      for (const command of commands) {
        await expect(
          executeOnServer({
            canvasId: 'canvas-world',
            commands: [command],
            originator: { source },
          }),
        ).rejects.toBeInstanceOf(WorldPreviewMutationError);
      }
    },
  );

  it('allows moving and resizing a managed preview', async () => {
    await executeOnServer({
      canvasId: 'canvas-world',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [
            {
              nodeId: 'node-preview' as CanvasNodeId,
              position: { x: 999, y: 888 },
              size: { width: 900, height: 600 },
            },
          ],
        },
      ],
    });
    expect((await previews())[0]).toMatchObject({
      id: 'node-preview',
      position: { x: 999, y: 888 },
      style: { width: 900, height: 600 },
    });
  });

  it('rejects reparent-then-delete through the sequential result check', async () => {
    await executeOnServer({
      canvasId: 'canvas-world',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-frame' as CanvasNodeId,
              nodeType: 'frame',
              position: { x: 0, y: 0 },
            },
          ],
        },
      ],
    });
    await expect(
      executeOnServer({
        canvasId: 'canvas-world',
        originator: { source: 'ui' },
        commands: [
          {
            type: 'SET_NODE_PARENT',
            nodeIds: ['node-preview' as CanvasNodeId],
            parentId: 'node-frame' as CanvasNodeId,
          },
          { type: 'DELETE_NODES', nodeIds: ['node-frame' as CanvasNodeId] },
        ],
      }),
    ).rejects.toBeInstanceOf(WorldPreviewMutationError);
  });

  it('protects full-state identity while allowing geometry and ordinary previews', () => {
    const current = preview();
    const live = new Set(['canvas-a', 'canvas-b']);
    for (const next of [
      [],
      [preview('node-copy')],
      [preview('node-preview', 'canvas-b')],
      [current, preview('node-copy')],
      [{ ...current, type: 'note' }],
    ]) {
      expect(() =>
        assertWorldPreviewTopologyAllowed(
          'canvas-world',
          [current],
          next,
          live,
        ),
      ).toThrow(WorldPreviewMutationError);
    }
    expect(() =>
      assertWorldPreviewTopologyAllowed(
        'canvas-world',
        [current],
        [
          {
            ...current,
            position: { x: 900, y: 800 },
            style: { width: 800, height: 600 },
          },
        ],
        live,
      ),
    ).not.toThrow();
    expect(() =>
      assertWorldPreviewTopologyAllowed('canvas-a', [], [preview()], live),
    ).not.toThrow();
    expect(() =>
      assertWorldPreviewTopologyAllowed(
        'canvas-world',
        [current],
        [],
        new Set(),
      ),
    ).not.toThrow();
  });
});

describe('Canonical canvas write boundaries', () => {
  it('accepts the full registry, including UI-only commands, but requires a discriminator', () => {
    expect(() =>
      assertCurrentCanvasCommands(
        Object.keys(COMMAND_META).map((type) => ({ type })),
      ),
    ).not.toThrow();
    for (const command of [null, {}, { type: 42 }]) {
      expect(() => assertCurrentCanvasCommands([command])).toThrow(
        WorldPreviewMutationError,
      );
    }
    expect(() =>
      assertCurrentCanvasNodeTypes([{}, { type: 'note' }, { data: {} }]),
    ).not.toThrow();
    for (const node of [{ type: null }, { data: { type: 42 } }]) {
      expect(() => assertCurrentCanvasNodeTypes([node])).toThrow(
        WorldPreviewMutationError,
      );
    }
  });

  it.each(['future-invalid', 'canvasRef'])(
    'cannot persist %s through commands or full PUT',
    async (nodeType) => {
      writeCanvas('Project A', 'canvas-a', [
        { ...preview('node-note'), type: 'note', data: {} },
      ]);
      const app = Fastify();
      await app.register(canvasRoutes, { prefix: '/canvas' });
      try {
        for (const canvasId of ['canvas-a', 'canvas-world']) {
          const before = await space(canvasId).read();
          const diskBefore = diskSnapshot();
          for (const command of [
            {
              type: 'CREATE_NODES',
              nodes: [{ nodeType, position: { x: 0, y: 0 } }],
            },
            { type: 'CHANGE_NODE_TYPE', nodeId: 'node-note', to: nodeType },
            {
              type: 'MERGE_NODE_DATA',
              patches: [{ nodeId: 'node-note', patch: { type: nodeType } }],
            },
            { type: 'CHANGE_NODE_TYPE', nodeId: 'node-missing', to: nodeType },
          ]) {
            const response = await app.inject({
              method: 'POST',
              url: `/canvas/${canvasId}/execute`,
              payload: { commands: [command], originator: { source: 'ui' } },
            });
            if (response.statusCode === 200) {
              expect(response.json().results[0].applied).toBe(false);
              expect(response.json().toVersion).toBe(before?.version);
            } else {
              expect(response.statusCode).toBe(409);
            }
            expect(diskSnapshot()).toEqual(diskBefore);
          }
          for (const node of [
            { ...preview(), type: nodeType },
            { ...preview(), type: 'note', data: { type: nodeType } },
          ]) {
            const put = await app.inject({
              method: 'PUT',
              url: `/canvas/${canvasId}`,
              payload: {
                version: before?.version,
                state: { nodes: [node], edges: [] },
              },
            });
            expect(put.statusCode).toBe(409);
            expect(diskSnapshot()).toEqual(diskBefore);
          }
          expect(await space(canvasId).read()).toEqual(before);
        }
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/canvas/canvas-world/references',
            })
          ).statusCode,
        ).toBe(404);
      } finally {
        await app.close();
      }
    },
  );

  it('preserves unknown types on read but rejects writing them back; omitted types remain valid', async () => {
    const node = { ...preview(), type: 'future-invalid' };
    writeCanvas('Project A', 'canvas-a', [node]);
    const before = diskSnapshot();
    expect((await space('canvas-a').read())?.state.nodes).toEqual([node]);
    expect(diskSnapshot()).toEqual(before);
    const app = Fastify();
    await app.register(canvasRoutes, { prefix: '/canvas' });
    try {
      const put = (nodes: unknown[]) =>
        app.inject({
          method: 'PUT',
          url: '/canvas/canvas-a',
          payload: { version: 0, state: { nodes, edges: [] } },
        });
      expect((await put([node])).statusCode).toBe(409);
      expect(diskSnapshot()).toEqual(before);
      expect(
        (await put([{ id: 'node-loose', position: { x: 0, y: 0 }, data: {} }]))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it.each([
    { type: 'FUTURE_COMMAND' },
    { type: 'toString' },
    { type: '__proto__' },
    { type: 'SET_PORTAL_NODE_PINS', updates: [] },
    { type: 'CREATE_NODES', nodes: [{ nodeType: 'future-invalid' }] },
    {
      type: 'CREATE_NODES',
      nodes: [{ nodeType: 'image', data: { type: 'future-invalid' } }],
    },
  ])('preflights $type before any media I/O or disk write', async (invalid) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('unused', { headers: { 'content-type': 'image/png' } }),
      );
    const before = diskSnapshot();
    try {
      await expect(
        executeOnServer({
          canvasId: 'canvas-a',
          originator: { source: 'agent' },
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  nodeType: 'image',
                  data: { src: 'https://example.com/a.png' },
                },
              ],
            },
            invalid,
          ] as unknown as CanvasCommand[],
        }),
      ).rejects.toBeInstanceOf(WorldPreviewMutationError);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(diskSnapshot()).toEqual(before);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
