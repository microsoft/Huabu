import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../workspace.js', () => ({
  getWorkspacePath: () => workspaceState.path,
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

import type { CanvasCommand, CanvasNodeId } from '@sediment/shared';

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
    path.join(tmpdir(), 'sediment-world-portals-'),
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
});
