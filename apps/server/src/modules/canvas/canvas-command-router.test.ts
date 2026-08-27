// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAbsolutePosition } from '@huabu/shared/canvas-engine';

import {
  CanvasCommandRoutingError,
  executeCanvasCommandsOnHost,
} from './canvas-command-router.js';
import {
  assertWorldPortalTopologyAllowed,
  WorldPortalMutationError,
} from './world-portal-policy.js';
import {
  reconcileWorldPortals,
  WorldPortalIntegrityError,
} from './world-portals.js';
import { refreshCanvasDirIndex } from '../storage/canvas-dirs.js';
import { getCanvasStore, resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand, CanvasNodeId } from '@huabu/shared';
import type { NestableNode } from '@huabu/shared/canvas-engine';

let workspace: string;

interface TestStoredNode {
  id: string;
  type?: string;
  parentId?: string;
  position?: { x: number; y: number };
  style?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function writeCanvas(
  directory: string,
  canvasId: string,
  nodes: unknown[] = [],
): void {
  const root = path.join(workspace, directory);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'space.json'),
    JSON.stringify({
      canvasId,
      title: directory,
      version: 0,
      state: { nodes, edges: [] },
      createdAt: 1,
      updatedAt: 1,
    }),
    'utf8',
  );
}

function pin(
  sourceCanvasId: `canvas-${string}`,
  sourceNodeIds: CanvasNodeId[],
  pinned = true,
): CanvasCommand {
  return {
    type: 'SET_PORTAL_NODE_PINS',
    updates: [{ sourceCanvasId, sourceNodeIds, pinned }],
  };
}

function writeNestedFrameSource(includeLaterChild = false): void {
  writeCanvas('Project A', 'canvas-a', [
    {
      id: 'node-outer',
      type: 'frame',
      position: { x: 10, y: 20 },
      style: { width: 500, height: 400 },
      data: { type: 'frame' },
    },
    {
      id: 'node-inner',
      type: 'frame',
      parentId: 'node-outer',
      position: { x: 100, y: 80 },
      style: { width: 250, height: 200 },
      data: { type: 'frame' },
    },
    {
      id: 'node-inner-child',
      type: 'note',
      parentId: 'node-inner',
      position: { x: 30, y: 40 },
      style: { width: 100, height: 80 },
      data: { type: 'note' },
    },
    ...(includeLaterChild
      ? [
          {
            id: 'node-later-child',
            type: 'note',
            parentId: 'node-inner',
            position: { x: 150, y: 80 },
            style: { width: 80, height: 60 },
            data: { type: 'note' },
          },
        ]
      : []),
  ]);
  resetStorageCache();
}

function referenceFor(sourceNodeId: string): TestStoredNode | undefined {
  return (
    getCanvasStore('canvas-world').read()?.state.nodes as TestStoredNode[]
  ).find(
    (node) =>
      (node.type === 'nodeRef' || node.type === 'frameRef') &&
      (node.data?.target as { nodeId?: string } | undefined)?.nodeId ===
        sourceNodeId,
  );
}

beforeEach(async () => {
  // Outside the repo: these tests rename over `space.json`, and on Windows that
  // fails with EPERM while any handle is open on the target — which a dev
  // server's file watcher, the IDE indexer, or antivirus will happily hold on
  // anything inside the working tree. `mkdtemp` also makes the name unique, so
  // parallel workers cannot collide.
  workspace = mkdtempSync(path.join(tmpdir(), 'huabu-portal-router-'));
  setWorkspacePath(workspace);
  writeCanvas('.world', 'canvas-world');
  writeCanvas('Project A', 'canvas-a', [
    {
      id: 'node-a',
      type: 'note',
      position: { x: 10, y: 20 },
      style: { width: 100, height: 80 },
      data: {},
    },
  ]);
  writeCanvas('Project B', 'canvas-b', [
    {
      id: 'node-b',
      type: 'note',
      position: { x: 400, y: 200 },
      style: { width: 100, height: 80 },
      data: {},
    },
  ]);
  resetStorageCache();
  await reconcileWorldPortals();
});

afterEach(() => {
  resetStorageCache();
  rmSync(workspace, { recursive: true, force: true });
});

describe.skip('legacy World Portal pin command routing', () => {
  it('snapshots nested Frames, adopts refs, and recursively unpins World hierarchy', async () => {
    writeCanvas('Project A', 'canvas-a', [
      {
        id: 'node-frame',
        type: 'frame',
        position: { x: 10, y: 20 },
        style: { width: 500, height: 400 },
        data: { type: 'frame' },
      },
      {
        id: 'node-child',
        type: 'note',
        parentId: 'node-frame',
        position: { x: 40, y: 60 },
        style: { width: 100, height: 80 },
        data: { type: 'note' },
      },
      {
        id: 'node-nested',
        type: 'frame',
        parentId: 'node-frame',
        position: { x: 220, y: 120 },
        style: { width: 200, height: 160 },
        data: { type: 'frame' },
      },
      {
        id: 'node-leaf',
        type: 'note',
        parentId: 'node-nested',
        position: { x: 20, y: 30 },
        style: { width: 80, height: 60 },
        data: { type: 'note' },
      },
    ]);
    resetStorageCache();

    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-child' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    let worldNodes = getCanvasStore('canvas-world').read()?.state
      .nodes as TestStoredNode[];
    const adopted = worldNodes.find(
      (node) =>
        node.data?.target &&
        (node.data.target as { nodeId?: string }).nodeId === 'node-child',
    );
    const adoptedAbs = getAbsolutePosition(
      worldNodes as NestableNode[],
      adopted?.id ?? '',
    );

    const first = await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-frame' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    expect(first.toVersion).toBe(first.fromVersion + 1);
    worldNodes = getCanvasStore('canvas-world').read()?.state
      .nodes as TestStoredNode[];
    const references = worldNodes.filter(
      (node) => node.type === 'nodeRef' || node.type === 'frameRef',
    );
    expect(references).toHaveLength(4);
    const frameRef = references.find(
      (node) =>
        node.type === 'frameRef' &&
        (node.data?.target as { nodeId?: string })?.nodeId === 'node-frame',
    );
    const nestedRef = references.find(
      (node) =>
        node.type === 'frameRef' &&
        (node.data?.target as { nodeId?: string })?.nodeId === 'node-nested',
    );
    const adoptedAfter = references.find((node) => node.id === adopted?.id);
    const leafRef = references.find(
      (node) =>
        (node.data?.target as { nodeId?: string })?.nodeId === 'node-leaf',
    );
    expect(adoptedAfter?.parentId).toBe(frameRef?.id);
    expect(nestedRef?.parentId).toBe(frameRef?.id);
    expect(leafRef?.parentId).toBe(nestedRef?.id);
    expect(
      getAbsolutePosition(worldNodes as NestableNode[], adoptedAfter?.id ?? ''),
    ).toEqual(adoptedAbs);

    const idempotent = await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-frame' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    expect(idempotent.toVersion).toBe(idempotent.fromVersion);

    writeCanvas('Project A', 'canvas-a', []);
    resetStorageCache();
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-frame' as CanvasNodeId], false)],
      originator: { source: 'ui' },
    });
    expect(
      (
        getCanvasStore('canvas-world').read()?.state.nodes as TestStoredNode[]
      ).filter((node) => node.type === 'nodeRef' || node.type === 'frameRef'),
    ).toHaveLength(0);
  });

  it('parents a later single Pin to the nearest existing frameRef', async () => {
    writeCanvas('Project A', 'canvas-a', [
      {
        id: 'node-frame',
        type: 'frame',
        position: { x: 10, y: 20 },
        style: { width: 300, height: 200 },
        data: { type: 'frame' },
      },
    ]);
    resetStorageCache();
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-frame' as CanvasNodeId])],
      originator: { source: 'ui' },
    });

    writeCanvas('Project A', 'canvas-a', [
      {
        id: 'node-frame',
        type: 'frame',
        position: { x: 10, y: 20 },
        style: { width: 300, height: 200 },
        data: { type: 'frame' },
      },
      {
        id: 'node-later',
        type: 'note',
        parentId: 'node-frame',
        position: { x: 70, y: 50 },
        style: { width: 100, height: 80 },
        data: { type: 'note' },
      },
    ]);
    resetStorageCache();
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-later' as CanvasNodeId])],
      originator: { source: 'ui' },
    });

    const nodes = getCanvasStore('canvas-world').read()?.state
      .nodes as TestStoredNode[];
    const frameRef = nodes.find((node) => node.type === 'frameRef');
    const child = nodes.find(
      (node) =>
        node.type === 'nodeRef' &&
        (node.data?.target as { nodeId?: string })?.nodeId === 'node-later',
    );
    expect(child?.parentId).toBe(frameRef?.id);
  });

  it('keeps an explicitly re-pinned nested Frame under its outer frameRef', async () => {
    writeNestedFrameSource();
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-outer' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    const outerRef = referenceFor('node-outer');
    const innerRef = referenceFor('node-inner');
    expect(innerRef?.parentId).toBe(outerRef?.id);

    const repeated = await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-inner' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    expect(repeated.toVersion).toBe(repeated.fromVersion);
    expect(referenceFor('node-inner')?.parentId).toBe(outerRef?.id);
  });

  it('does not reconcile later source descendants when re-pinning a frameRef', async () => {
    writeNestedFrameSource();
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-outer' as CanvasNodeId])],
      originator: { source: 'ui' },
    });

    writeNestedFrameSource(true);
    const repeated = await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-outer' as CanvasNodeId])],
      originator: { source: 'ui' },
    });

    expect(repeated.toVersion).toBe(repeated.fromVersion);
    expect(referenceFor('node-later-child')).toBeUndefined();
  });

  it('serializes concurrent Frame and descendant Pins before preparation', async () => {
    writeNestedFrameSource();

    await Promise.all([
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-a',
        commands: [pin('canvas-a', ['node-outer' as CanvasNodeId])],
        originator: { source: 'ui' },
      }),
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-a',
        commands: [pin('canvas-a', ['node-inner-child' as CanvasNodeId])],
        originator: { source: 'ui' },
      }),
    ]);

    expect(referenceFor('node-inner-child')?.parentId).toBe(
      referenceFor('node-inner')?.id,
    );
  });

  it('keeps outer then nested Frame Pins ordered within one batch', async () => {
    writeNestedFrameSource();
    const output = await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [
        pin('canvas-a', ['node-outer' as CanvasNodeId]),
        pin('canvas-a', ['node-inner' as CanvasNodeId]),
      ],
      originator: { source: 'ui' },
    });

    expect(output.results).toHaveLength(2);
    expect(output.results[0]).toMatchObject({ applied: true });
    expect(output.results[1]).toMatchObject({ applied: false });
    expect(referenceFor('node-inner')?.parentId).toBe(
      referenceFor('node-outer')?.id,
    );
  });

  it('adopts nested then outer Frame Pins ordered in reverse within one batch', async () => {
    writeNestedFrameSource();
    const output = await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [
        pin('canvas-a', ['node-inner' as CanvasNodeId]),
        pin('canvas-a', ['node-outer' as CanvasNodeId]),
      ],
      originator: { source: 'ui' },
    });

    expect(output.results).toHaveLength(2);
    expect(output.results.every((result) => result.applied)).toBe(true);
    expect(referenceFor('node-inner')?.parentId).toBe(
      referenceFor('node-outer')?.id,
    );
  });

  it('adopts a descendant listed before its Frame in one command', async () => {
    writeNestedFrameSource();
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [
        pin('canvas-a', [
          'node-inner-child' as CanvasNodeId,
          'node-outer' as CanvasNodeId,
        ]),
      ],
      originator: { source: 'ui' },
    });

    expect(referenceFor('node-inner-child')?.parentId).toBe(
      referenceFor('node-inner')?.id,
    );
    expect(referenceFor('node-inner')?.parentId).toBe(
      referenceFor('node-outer')?.id,
    );
  });

  it('validates every source before mutating pins', async () => {
    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-a',
        commands: [
          pin('canvas-a', ['node-missing' as CanvasNodeId]),
          pin('canvas-b', ['node-b' as CanvasNodeId]),
        ],
        originator: { source: 'ui' },
      }),
    ).rejects.toBeInstanceOf(CanvasCommandRoutingError);

    const refs = (
      (getCanvasStore('canvas-world').read()?.state.nodes ?? []) as Array<{
        type?: string;
      }>
    ).filter((node) => node.type === 'nodeRef');
    expect(refs).toHaveLength(0);
    expect(getCanvasStore('canvas-world').read()?.version).toBe(1);
  });

  it('rejects a Frame Pin mixed with an explicit descendant Unpin', async () => {
    writeCanvas('Project A', 'canvas-a', [
      {
        id: 'node-frame',
        type: 'frame',
        position: { x: 0, y: 0 },
        style: { width: 300, height: 200 },
        data: { type: 'frame' },
      },
      {
        id: 'node-child',
        type: 'note',
        parentId: 'node-frame',
        position: { x: 20, y: 30 },
        data: { type: 'note' },
      },
    ]);
    resetStorageCache();
    const beforeVersion = getCanvasStore('canvas-world').read()?.version;

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-a',
        commands: [
          pin('canvas-a', ['node-frame' as CanvasNodeId]),
          pin('canvas-a', ['node-child' as CanvasNodeId], false),
        ],
        originator: { source: 'ui' },
      }),
    ).rejects.toThrow('Conflicting pin states');

    expect(getCanvasStore('canvas-world').read()?.version).toBe(beforeVersion);
  });

  it('creates a missing canonical Portal on demand before pinning', async () => {
    writeCanvas('.world', 'canvas-world');
    resetStorageCache();

    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-a' as CanvasNodeId])],
      originator: { source: 'ui' },
    });

    const worldNodes = getCanvasStore('canvas-world').read()?.state
      .nodes as TestStoredNode[];
    expect(
      worldNodes.some(
        (node) =>
          node.type === 'canvasRef' &&
          (node.data as { targetCanvasId?: string } | undefined)
            ?.targetCanvasId === 'canvas-a',
      ),
    ).toBe(true);
    expect(referenceFor('node-a')).toBeDefined();
  });

  it('preserves Portal reconciliation integrity errors', async () => {
    writeCanvas('.world', 'canvas-world', [
      {
        id: 'node-malformed-portal',
        type: 'canvasRef',
        position: { x: 0, y: 0 },
        data: {},
      },
    ]);
    resetStorageCache();

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-a',
        commands: [pin('canvas-a', ['node-a' as CanvasNodeId])],
        originator: { source: 'ui' },
      }),
    ).rejects.toBeInstanceOf(WorldPortalIntegrityError);
  });

  it('rejects pinning from a Space that no longer exists', async () => {
    writeCanvas('.world', 'canvas-world');
    resetStorageCache();

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-missing',
        commands: [pin('canvas-missing', ['node-a' as CanvasNodeId])],
        originator: { source: 'ui' },
      }),
    ).rejects.toThrow(
      'Canvas canvas-missing is not a live Space, so it owns no canonical Portal',
    );
  });

  it('routes several Portals into one World version transition', async () => {
    const output = await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [
        {
          type: 'SET_PORTAL_NODE_PINS',
          updates: [
            {
              sourceCanvasId: 'canvas-a',
              sourceNodeIds: ['node-a' as CanvasNodeId],
              pinned: true,
            },
            {
              sourceCanvasId: 'canvas-b',
              sourceNodeIds: ['node-b' as CanvasNodeId],
              pinned: true,
            },
          ],
        },
      ],
      originator: { source: 'agent' },
    });

    expect(output.canvasId).toBe('canvas-world');
    expect(output.fromVersion).toBe(1);
    expect(output.toVersion).toBe(2);
    expect(output.toVersion).toBe(output.fromVersion + 1);
    expect(output.commands[0]).not.toHaveProperty('prepared');
    const worldNodes = getCanvasStore('canvas-world').read()?.state.nodes as
      | Array<{
          id: string;
          type?: string;
          parentId?: string;
          data?: {
            targetCanvasId?: string;
            target?: { canvasId?: string };
          };
        }>
      | undefined;
    const portals = new Map(
      (worldNodes ?? [])
        .filter((node) => node.type === 'canvasRef')
        .map((node) => [node.data?.targetCanvasId, node.id]),
    );
    const refs = (worldNodes ?? []).filter((node) => node.type === 'nodeRef');
    expect(refs).toHaveLength(2);
    expect(
      refs.every(
        (ref) =>
          ref.parentId !== undefined &&
          portals.get(ref.data?.target?.canvasId) === ref.parentId,
      ),
    ).toBe(true);
  });

  it('keeps concurrent Pin requests idempotent', async () => {
    await Promise.all([
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-a',
        commands: [pin('canvas-a', ['node-a' as CanvasNodeId])],
        originator: { source: 'ui' },
      }),
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-a',
        commands: [pin('canvas-a', ['node-a' as CanvasNodeId])],
        originator: { source: 'ui' },
      }),
    ]);

    const nodes = getCanvasStore('canvas-world').read()?.state.nodes as Array<{
      type?: string;
      data?: {
        targetCanvasId?: string;
        target?: { canvasId?: string; nodeId?: string };
      };
    }>;
    expect(
      nodes.filter(
        (node) =>
          node.type === 'canvasRef' && node.data?.targetCanvasId === 'canvas-a',
      ),
    ).toHaveLength(1);
    expect(
      nodes.filter(
        (node) =>
          node.type === 'nodeRef' &&
          node.data?.target?.canvasId === 'canvas-a' &&
          node.data.target.nodeId === 'node-a',
      ),
    ).toHaveLength(1);
  });

  it('allows a broken reference to be unpinned', async () => {
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-a' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    rmSync(path.join(workspace, 'Project A'), {
      recursive: true,
      force: true,
    });
    refreshCanvasDirIndex();
    const brokenTopology = getCanvasStore('canvas-world').read()?.state.nodes;
    if (!brokenTopology) throw new Error('Missing broken Portal state');
    const convertedDescendant = (
      structuredClone(brokenTopology) as Array<{
        id?: string;
        type?: string;
        parentId?: string;
        data?: {
          targetCanvasId?: string;
          target?: { canvasId?: string };
        };
      }>
    )
      .filter(
        (node) =>
          node.type !== 'canvasRef' || node.data?.targetCanvasId !== 'canvas-a',
      )
      .map((node) =>
        node.type === 'nodeRef' && node.data?.target?.canvasId === 'canvas-a'
          ? { ...node, type: 'note' }
          : node,
      );
    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        brokenTopology,
        convertedDescendant,
      ),
    ).toThrow('A node reference cannot change node type');

    const output = await executeCanvasCommandsOnHost({
      canvasId: 'canvas-world',
      commands: [pin('canvas-a', ['node-a' as CanvasNodeId], false)],
      originator: { source: 'ui' },
    });
    expect(output.results[0]?.applied).toBe(true);
    expect(
      (
        (getCanvasStore('canvas-world').read()?.state.nodes ?? []) as Array<{
          type?: string;
        }>
      ).some((node) => node.type === 'nodeRef'),
    ).toBe(false);
  });

  it('rejects mixed local and World mutations before execution', async () => {
    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-a',
        commands: [
          pin('canvas-a', ['node-a' as CanvasNodeId]),
          {
            type: 'DELETE_NODES',
            nodeIds: ['node-a' as CanvasNodeId],
          },
        ],
        originator: { source: 'ui' },
      }),
    ).rejects.toThrow(
      'Portal Pin commands cannot be mixed with source-Canvas commands',
    );
    expect(getCanvasStore('canvas-a').read()?.version).toBe(0);
    expect(getCanvasStore('canvas-world').read()?.version).toBe(1);
  });

  it('protects a live Portal from recursive ancestor deletion', async () => {
    const worldStore = getCanvasStore('canvas-world');
    const world = worldStore.read();
    if (!world) throw new Error('Missing World state');
    const portal = (
      world.state.nodes as Array<{
        id: string;
        type?: string;
        data?: { targetCanvasId?: string };
      }>
    ).find(
      (node) =>
        node.type === 'canvasRef' && node.data?.targetCanvasId === 'canvas-a',
    );
    if (!portal) throw new Error('Missing live Portal');
    worldStore.write({
      ...world,
      state: {
        ...world.state,
        nodes: [
          {
            id: 'node-frame',
            type: 'frame',
            position: { x: 0, y: 0 },
            data: { type: 'frame' },
          },
          ...(world.state.nodes as Array<Record<string, unknown>>),
        ],
      },
    });

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-world',
        commands: [
          {
            type: 'SET_NODE_PARENT',
            nodeIds: [portal.id as CanvasNodeId],
            parentId: 'node-frame' as CanvasNodeId,
          },
          {
            type: 'DELETE_NODES',
            nodeIds: ['node-frame' as CanvasNodeId],
          },
        ],
        originator: { source: 'ui' },
      }),
    ).rejects.toThrow('A live canonical Portal cannot be deleted');
  });

  it('preserves ordinary lock behavior for node references', async () => {
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-a' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    const beforeLock = getCanvasStore('canvas-world').read()?.state.nodes as
      | TestStoredNode[]
      | undefined;
    if (!beforeLock) throw new Error('Missing World state');
    const nodeRef = beforeLock.find((node) => node.type === 'nodeRef');
    const portal = beforeLock.find((node) => node.type === 'canvasRef');
    if (!nodeRef || !portal) throw new Error('Missing Portal topology');

    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-world',
      commands: [
        {
          type: 'SET_NODE_LOCKED',
          items: [{ nodeId: nodeRef.id as CanvasNodeId, locked: true }],
        },
      ],
      originator: { source: 'ui' },
    });
    const directlyLocked = getCanvasStore('canvas-world').read()?.state
      .nodes as TestStoredNode[] | undefined;
    if (!directlyLocked) throw new Error('Missing locked World state');
    expect(
      directlyLocked.find((node) => node.id === nodeRef.id)?.data,
    ).toMatchObject({ locked: true });
    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        directlyLocked,
        directlyLocked,
      ),
    ).not.toThrow();

    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-world',
      commands: [
        {
          type: 'SET_NODE_LOCKED',
          items: [{ nodeId: nodeRef.id as CanvasNodeId, locked: false }],
        },
        {
          type: 'SET_NODE_LOCKED',
          items: [{ nodeId: portal.id as CanvasNodeId, locked: true }],
        },
      ],
      originator: { source: 'ui' },
    });
    const portalLocked = getCanvasStore('canvas-world').read()?.state.nodes as
      | TestStoredNode[]
      | undefined;
    if (!portalLocked) throw new Error('Missing locked Portal state');
    expect(
      portalLocked.find((node) => node.id === nodeRef.id)?.data,
    ).toMatchObject({ __dragDisabledByFrameLock: true });
    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        portalLocked,
        portalLocked,
      ),
    ).not.toThrow();

    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-world',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId: nodeRef.id as CanvasNodeId,
              patch: { style: { accent: 'blue' } },
            },
          ],
        },
      ],
      originator: { source: 'ui' },
    });
    const styled = getCanvasStore('canvas-world').read()?.state.nodes as
      | TestStoredNode[]
      | undefined;
    expect(styled?.find((node) => node.id === nodeRef.id)?.data).toMatchObject({
      style: { accent: 'blue' },
    });

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-world',
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: nodeRef.id as CanvasNodeId,
                patch: { label: 'Copied source label' },
              },
            ],
          },
        ],
        originator: { source: 'ui' },
      }),
    ).rejects.toThrow(
      'A node reference cannot persist copied source-owned data',
    );

    const copiedTarget = structuredClone(styled);
    const copiedTargetRef = copiedTarget?.find(
      (node) => node.id === nodeRef.id,
    );
    const target = copiedTargetRef?.data?.target as
      | Record<string, unknown>
      | undefined;
    if (!copiedTarget || !target) throw new Error('Missing nodeRef target');
    target.label = 'Copied source label';
    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        styled ?? [],
        copiedTarget,
      ),
    ).toThrow('contains unsupported source-owned data');

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-world',
        commands: [
          {
            type: 'DISSOLVE_FRAME',
            frameId: portal.id as CanvasNodeId,
          },
        ],
        originator: { source: 'ui' },
      }),
    ).rejects.toThrow('Portals and node references cannot be dissolved');

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-world',
        commands: [
          {
            type: 'CHANGE_NODE_TYPE',
            nodeId: nodeRef.id as CanvasNodeId,
            to: 'note',
          },
        ],
        originator: { source: 'ui' },
      }),
    ).rejects.toThrow('Portals and node references cannot change node type');
  });

  it('accepts derived Portal fit but rejects a manual Portal resize', async () => {
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-a' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    const previous = getCanvasStore('canvas-world').read()?.state.nodes;
    if (!previous) throw new Error('Missing World state');
    const canonical = structuredClone(previous);
    expect(() =>
      assertWorldPortalTopologyAllowed('canvas-world', previous, canonical),
    ).not.toThrow();

    const resized = structuredClone(previous) as Array<{
      type?: string;
      style?: { width?: number };
    }>;
    const portal = resized.find((node) => node.type === 'canvasRef');
    if (!portal?.style) throw new Error('Missing Portal');
    portal.style.width = (portal.style.width ?? 0) + 100;
    expect(() =>
      assertWorldPortalTopologyAllowed('canvas-world', previous, resized),
    ).toThrow(WorldPortalMutationError);

    const withoutNodeRef = (
      structuredClone(previous) as Array<{ type?: string }>
    ).filter((node) => node.type !== 'nodeRef');
    expect(() =>
      assertWorldPortalTopologyAllowed(
        'canvas-world',
        previous,
        withoutNodeRef,
      ),
    ).toThrow('Node references must be removed with SET_PORTAL_NODE_PINS');
  });

  it('allows moving but rejects manually resizing a frameRef', async () => {
    writeCanvas('Project A', 'canvas-a', [
      {
        id: 'node-frame',
        type: 'frame',
        position: { x: 10, y: 20 },
        style: { width: 300, height: 200 },
        data: { type: 'frame' },
      },
    ]);
    resetStorageCache();
    await executeCanvasCommandsOnHost({
      canvasId: 'canvas-a',
      commands: [pin('canvas-a', ['node-frame' as CanvasNodeId])],
      originator: { source: 'ui' },
    });
    const frameRef = (
      getCanvasStore('canvas-world').read()?.state.nodes as TestStoredNode[]
    ).find((node) => node.type === 'frameRef');
    if (!frameRef) throw new Error('Missing frameRef');

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-world',
        commands: [
          {
            type: 'SET_NODE_GEOMETRY',
            items: [
              {
                nodeId: frameRef.id as CanvasNodeId,
                position: { x: 80, y: 90 },
              },
            ],
          },
        ],
        originator: { source: 'ui' },
      }),
    ).resolves.toMatchObject({
      results: [expect.objectContaining({ applied: true })],
    });

    await expect(
      executeCanvasCommandsOnHost({
        canvasId: 'canvas-world',
        commands: [
          {
            type: 'SET_NODE_GEOMETRY',
            items: [
              {
                nodeId: frameRef.id as CanvasNodeId,
                size: { width: 500, height: 400 },
              },
            ],
          },
        ],
        originator: { source: 'agent' },
      }),
    ).rejects.toThrow(
      'Portal and frame reference sizes are managed by their contents',
    );
  });
});
