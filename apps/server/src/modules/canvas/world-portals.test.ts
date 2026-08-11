// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fitPortalToChildren, fitPortals } from '@huabu/shared/canvas-engine';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
  withWorkspaceOperationLease: async <T>(
    task: (workspacePath: string) => Promise<T>,
  ) => task(workspaceState.path),
}));

import { executeOnServer } from './canvas-executor.js';
import {
  assertWorldPortalTopologyAllowed,
  WorldPortalMutationError,
} from './world-portal-policy.js';
import {
  reconcileWorldPortals,
  WorldPortalIntegrityError,
} from './world-portals.js';
import { refreshCanvasDirIndex } from '../storage/canvas-dirs.js';
import { getCanvasStore } from '../storage/index.js';

import type { CanvasCommand, CanvasNodeId } from '@huabu/shared';
import type { NestableNode } from '@huabu/shared/canvas-engine';

function writeCanvas(
  directory: string,
  canvasId: string,
  title: string,
  nodes: unknown[] = [],
): void {
  const root = path.join(workspaceState.path, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'space.json'),
    JSON.stringify({
      canvasId,
      title,
      version: 0,
      state: { nodes, edges: [] },
      createdAt: 1,
      updatedAt: 1,
    }),
    'utf8',
  );
}

function portals(): Array<{
  id: string;
  position: { x: number; y: number };
  data: { targetCanvasId: string };
}> {
  const canvas = getCanvasStore('canvas-world').read();
  const nodes = (canvas?.state.nodes ?? []) as Array<{
    id: string;
    type?: string;
    position: { x: number; y: number };
    data: { targetCanvasId: string };
  }>;
  return nodes.filter((node) => node.type === 'canvasRef');
}

beforeEach(() => {
  workspaceState.path = mkdtempSync(
    path.join(tmpdir(), 'huabu-world-portals-'),
  );
  writeCanvas('.world', 'canvas-world', 'World', [
    {
      id: 'note-1',
      type: 'note',
      position: { x: 0, y: 0 },
      style: { width: 200, height: 100 },
      data: {},
    },
  ]);
  writeCanvas('Project A', 'canvas-a', 'Project A');
  writeCanvas('Project B', 'canvas-b', 'Project B');
  refreshCanvasDirIndex();
});

afterEach(() => {
  rmSync(workspaceState.path, { recursive: true, force: true });
});

describe('World Portal reconciliation', () => {
  it('creates one deterministic Portal per live Space and is idempotent', async () => {
    await reconcileWorldPortals();

    expect(
      portals().map((portal) => ({
        target: portal.data.targetCanvasId,
        position: portal.position,
      })),
    ).toEqual([
      { target: 'canvas-a', position: { x: 440, y: 0 } },
      { target: 'canvas-b', position: { x: 880, y: 0 } },
    ]);
    expect(getCanvasStore('canvas-world').read()?.version).toBe(1);

    await reconcileWorldPortals();
    expect(portals()).toHaveLength(2);
    expect(getCanvasStore('canvas-world').read()?.version).toBe(1);
  });

  it('preserves existing geometry and leaves broken Portals in place', async () => {
    await reconcileWorldPortals();
    const worldStore = getCanvasStore('canvas-world');
    const world = worldStore.read();
    if (!world) throw new Error('Missing World Canvas');
    const nodes = world.state.nodes as Array<{
      position: { x: number; y: number };
      data?: { targetCanvasId?: string };
    }>;
    const existing = nodes.find(
      (node) => node.data?.targetCanvasId === 'canvas-a',
    );
    if (!existing) throw new Error('Missing Portal');
    existing.position = { x: 1234, y: 5678 };
    worldStore.write(world);

    rmSync(path.join(workspaceState.path, 'Project B'), {
      recursive: true,
      force: true,
    });
    writeCanvas('Project C', 'canvas-c', 'Project C');
    refreshCanvasDirIndex();
    await reconcileWorldPortals();

    expect(
      portals().find((portal) => portal.data.targetCanvasId === 'canvas-a')
        ?.position,
    ).toEqual({ x: 1234, y: 5678 });
    expect(
      portals()
        .map((portal) => portal.data.targetCanvasId)
        .sort(),
    ).toEqual(['canvas-a', 'canvas-b', 'canvas-c']);
  });

  it('rejects duplicate or malformed Portal identities', async () => {
    writeCanvas('.world', 'canvas-world', 'World', [
      {
        id: 'portal-a',
        type: 'canvasRef',
        position: { x: 0, y: 0 },
        data: { targetCanvasId: 'canvas-a' },
      },
      {
        id: 'portal-a-copy',
        type: 'canvasRef',
        position: { x: 440, y: 0 },
        data: { targetCanvasId: 'canvas-a' },
      },
    ]);
    refreshCanvasDirIndex();

    await expect(reconcileWorldPortals()).rejects.toBeInstanceOf(
      WorldPortalIntegrityError,
    );
  });

  it('protects live Portals while allowing a broken Portal to be removed', async () => {
    await reconcileWorldPortals();
    const portal = portals().find(
      (candidate) => candidate.data.targetCanvasId === 'canvas-a',
    );
    if (!portal) throw new Error('Missing Portal');
    const removePortal: CanvasCommand = {
      type: 'DELETE_NODES',
      nodeIds: [portal.id as CanvasNodeId],
    };

    await expect(
      executeOnServer({
        canvasId: 'canvas-world',
        commands: [removePortal],
        originator: { source: 'ui' },
      }),
    ).rejects.toBeInstanceOf(WorldPortalMutationError);

    rmSync(path.join(workspaceState.path, 'Project A'), {
      recursive: true,
      force: true,
    });
    refreshCanvasDirIndex();
    await executeOnServer({
      canvasId: 'canvas-world',
      commands: [removePortal],
      originator: { source: 'ui' },
    });

    expect(
      portals().some(
        (candidate) => candidate.data.targetCanvasId === 'canvas-a',
      ),
    ).toBe(false);
  });

  it('protects canonical Portal identity across full-state writes', async () => {
    await reconcileWorldPortals();
    const previous = getCanvasStore('canvas-world').read()?.state.nodes;
    if (!previous) throw new Error('Missing World topology');

    expect(() =>
      assertWorldPortalTopologyAllowed('canvas-world', previous, []),
    ).toThrow(WorldPortalMutationError);

    const moved = structuredClone(previous) as Array<{
      type?: string;
      position: { x: number; y: number };
    }>;
    const portal = moved.find((node) => node.type === 'canvasRef');
    if (!portal) throw new Error('Missing Portal');
    portal.position = { x: 999, y: 999 };
    expect(() =>
      assertWorldPortalTopologyAllowed('canvas-world', previous, moved),
    ).not.toThrow();

    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-a',
        [],
        [
          {
            id: 'node-illegal',
            type: 'canvasRef',
            position: { x: 0, y: 0 },
            data: { targetCanvasId: 'canvas-b' },
          },
        ],
      ),
    ).toThrow(WorldPortalMutationError);
  });

  it('allows a nested reference subtree to leave with its broken Portal', async () => {
    const previous = [
      {
        id: 'node-portal',
        type: 'canvasRef',
        position: { x: 0, y: 0 },
        style: { width: 360, height: 240 },
        measured: { width: 360, height: 240 },
        data: { type: 'canvasRef', targetCanvasId: 'canvas-a' },
      },
      {
        id: 'node-frame-ref',
        type: 'frameRef',
        parentId: 'node-portal',
        position: { x: 24, y: 56 },
        style: { width: 200, height: 160 },
        measured: { width: 200, height: 160 },
        data: {
          type: 'frameRef',
          target: { canvasId: 'canvas-a', nodeId: 'node-frame' },
        },
      },
      {
        id: 'node-child-ref',
        type: 'nodeRef',
        parentId: 'node-frame-ref',
        position: { x: 20, y: 20 },
        style: { width: 180, height: 96 },
        measured: { width: 180, height: 96 },
        data: {
          type: 'nodeRef',
          target: { canvasId: 'canvas-a', nodeId: 'node-child' },
        },
      },
    ];
    rmSync(path.join(workspaceState.path, 'Project A'), {
      recursive: true,
      force: true,
    });
    refreshCanvasDirIndex();

    expect(() =>
      assertWorldPortalTopologyAllowed('canvas-world', previous, []),
    ).not.toThrow();
  });

  it('rejects a manually resized frameRef behind an apparently fitted Portal', () => {
    const raw = [
      {
        id: 'node-portal',
        type: 'canvasRef',
        position: { x: 0, y: 0 },
        style: { width: 360, height: 240 },
        measured: { width: 360, height: 240 },
        data: { type: 'canvasRef', targetCanvasId: 'canvas-a' },
      },
      {
        id: 'node-frame-ref',
        type: 'frameRef',
        parentId: 'node-portal',
        position: { x: 24, y: 56 },
        style: { width: 200, height: 160 },
        measured: { width: 200, height: 160 },
        data: {
          type: 'frameRef',
          target: { canvasId: 'canvas-a', nodeId: 'node-frame' },
        },
      },
      {
        id: 'node-child-ref',
        type: 'nodeRef',
        parentId: 'node-frame-ref',
        position: { x: 20, y: 20 },
        style: { width: 180, height: 96 },
        measured: { width: 180, height: 96 },
        data: {
          type: 'nodeRef',
          target: { canvasId: 'canvas-a', nodeId: 'node-child' },
        },
      },
    ] as NestableNode[];
    const canonical = fitPortals(raw, ['node-frame-ref', 'node-portal']);
    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        canonical,
        structuredClone(canonical),
      ),
    ).not.toThrow();

    const resized = structuredClone(canonical);
    const frameRef = resized.find((node) => node.id === 'node-frame-ref');
    if (!frameRef) throw new Error('Missing frameRef');
    frameRef.style = {
      ...frameRef.style,
      width: Number(frameRef.style?.width) + 100,
    };
    frameRef.measured = {
      ...frameRef.measured,
      width: Number(frameRef.measured?.width) + 100,
    };
    const apparentlyFitted = fitPortalToChildren(resized, 'node-portal');

    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        canonical,
        apparentlyFitted,
      ),
    ).toThrow('Frame reference size is managed by its contents');
  });

  it('rejects resizing an empty frameRef through a full-state write', () => {
    const raw = [
      {
        id: 'node-portal',
        type: 'canvasRef',
        position: { x: 0, y: 0 },
        style: { width: 360, height: 240 },
        measured: { width: 360, height: 240 },
        data: { type: 'canvasRef', targetCanvasId: 'canvas-a' },
      },
      {
        id: 'node-frame-ref',
        type: 'frameRef',
        parentId: 'node-portal',
        position: { x: 24, y: 56 },
        style: { width: 200, height: 160 },
        measured: { width: 200, height: 160 },
        data: {
          type: 'frameRef',
          target: { canvasId: 'canvas-a', nodeId: 'node-frame' },
        },
      },
    ] as NestableNode[];
    const canonical = fitPortals(raw, ['node-frame-ref', 'node-portal']);
    const resized = structuredClone(canonical);
    const frameRef = resized.find((node) => node.id === 'node-frame-ref');
    if (!frameRef) throw new Error('Missing frameRef');
    frameRef.style = {
      ...frameRef.style,
      width: Number(frameRef.style?.width) + 100,
    };
    const apparentlyFitted = fitPortalToChildren(resized, 'node-portal');

    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        canonical,
        apparentlyFitted,
      ),
    ).toThrow('Frame reference size is managed by its contents');
  });

  it('rejects cyclic frameRef topology without hanging during fit', () => {
    const cyclic = [
      {
        id: 'node-portal',
        type: 'canvasRef',
        position: { x: 0, y: 0 },
        style: { width: 360, height: 240 },
        measured: { width: 360, height: 240 },
        data: { type: 'canvasRef', targetCanvasId: 'canvas-a' },
      },
      {
        id: 'node-frame-a',
        type: 'frameRef',
        parentId: 'node-frame-b',
        position: { x: 0, y: 0 },
        style: { width: 200, height: 160 },
        data: {
          type: 'frameRef',
          target: { canvasId: 'canvas-a', nodeId: 'node-source-a' },
        },
      },
      {
        id: 'node-frame-b',
        type: 'frameRef',
        parentId: 'node-frame-a',
        position: { x: 0, y: 0 },
        style: { width: 200, height: 160 },
        data: {
          type: 'frameRef',
          target: { canvasId: 'canvas-a', nodeId: 'node-source-b' },
        },
      },
    ];

    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        cyclic,
        structuredClone(cyclic),
      ),
    ).toThrow('World reference hierarchy is cyclic');
  });
});
