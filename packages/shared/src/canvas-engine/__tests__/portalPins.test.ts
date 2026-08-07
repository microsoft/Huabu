// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { agentCanvasCommandSchema } from '../../types/api/space-operations.js';
import { executeCanvasCommands, getAbsolutePosition } from '../index.js';

import type {
  CanvasCommand,
  CanvasNodeId,
  PreparedPortalNodePins,
  PreparedPortalNodePinsCommand,
} from '../../types/canvas/index.js';
import type { NestableNode } from '../container/index.js';
import type { CanvasNode } from '../interfaces.js';

const sourceCanvasId = 'canvas-source' as const;
const portalId = 'node-portal' as CanvasNodeId;
const sourceA = 'node-source-a' as CanvasNodeId;
const sourceB = 'node-source-b' as CanvasNodeId;

function portal(): CanvasNode {
  return {
    id: portalId,
    type: 'canvasRef',
    position: { x: 100, y: 100 },
    style: { width: 360, height: 240 },
    measured: { width: 360, height: 240 },
    data: { type: 'canvasRef', targetCanvasId: sourceCanvasId },
  };
}

function prepared(
  pins: Array<{
    sourceNodeId: CanvasNodeId;
    nodeRefId: CanvasNodeId;
    pinned: boolean;
  }>,
): PreparedPortalNodePins {
  return {
    pins: pins.map((pin) => ({
      ...pin,
      sourceCanvasId,
      portalId,
    })),
    sourcePositions: [
      {
        sourceCanvasId,
        sourceNodeId: sourceA,
        position: { x: 0, y: 0 },
      },
      {
        sourceCanvasId,
        sourceNodeId: sourceB,
        position: { x: 400, y: 200 },
      },
    ],
  };
}

function run(command: CanvasCommand, nodes: CanvasNode[] = [portal()]) {
  return executeCanvasCommands(
    { source: 'agent', commands: [command] },
    { canvasId: 'canvas-world', nodes, edges: [] },
  );
}

function pinCommand(
  sourceNodeIds: CanvasNodeId[],
  internal: PreparedPortalNodePins,
  pinned = true,
): PreparedPortalNodePinsCommand {
  return {
    type: 'SET_PORTAL_NODE_PINS',
    updates: [{ sourceCanvasId, sourceNodeIds, pinned }],
    prepared: internal,
  };
}

describe('SET_PORTAL_NODE_PINS', () => {
  it('creates and recursively removes a fitted frameRef snapshot', () => {
    const frameSource = 'node-source-frame' as CanvasNodeId;
    const frameRefId = 'node-frame-ref' as CanvasNodeId;
    const childRefId = 'node-child-ref' as CanvasNodeId;
    const internal: PreparedPortalNodePins = {
      pins: [
        {
          sourceCanvasId,
          sourceNodeId: frameSource,
          portalId,
          nodeRefId: frameRefId,
          referenceType: 'frameRef',
          parentRefId: portalId,
          size: { width: 300, height: 200 },
          pinned: true,
        },
        {
          sourceCanvasId,
          sourceNodeId: sourceA,
          portalId,
          nodeRefId: childRefId,
          referenceType: 'nodeRef',
          parentRefId: frameRefId,
          position: { x: 80, y: 60 },
          pinned: true,
        },
      ],
      sourcePositions: [
        {
          sourceCanvasId,
          sourceNodeId: frameSource,
          position: { x: 20, y: 30 },
        },
      ],
    };
    const pinned = run(pinCommand([frameSource], internal)).writeResult
      .nodes as NestableNode[];
    const frameRef = pinned.find((node) => node.id === frameRefId);
    const childRef = pinned.find((node) => node.id === childRefId);
    expect(frameRef).toMatchObject({
      type: 'frameRef',
      parentId: portalId,
      data: {
        type: 'frameRef',
        target: { canvasId: sourceCanvasId, nodeId: frameSource },
      },
    });
    expect(childRef?.parentId).toBe(frameRefId);
    expect(getAbsolutePosition(pinned, childRefId)).toBeTruthy();

    const removed = run(
      pinCommand(
        [frameSource],
        {
          pins: [{ ...internal.pins[0], pinned: false }],
          sourcePositions: [],
        },
        false,
      ),
      pinned,
    );
    expect(
      removed.writeResult.nodes.some(
        (node) => node.id === frameRefId || node.id === childRefId,
      ),
    ).toBe(false);
    expect(removed.pendingEffects.deletedNodeIds).toEqual(
      expect.arrayContaining([frameRefId, childRefId]),
    );
  });

  it('uses strict canonical IDs on the public agent schema', () => {
    const valid = {
      type: 'SET_PORTAL_NODE_PINS',
      updates: [
        {
          sourceCanvasId,
          sourceNodeIds: [sourceA],
          pinned: true,
        },
      ],
    };
    expect(agentCanvasCommandSchema.safeParse(valid).success).toBe(true);
    expect(
      agentCanvasCommandSchema.safeParse({
        ...valid,
        updates: [
          {
            sourceCanvasId: 'source',
            sourceNodeIds: ['a'],
            pinned: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentCanvasCommandSchema.safeParse({
        ...valid,
        prepared: prepared([]),
      }).success,
    ).toBe(false);
  });

  it('rejects contradictory states atomically', () => {
    const command: PreparedPortalNodePinsCommand = {
      type: 'SET_PORTAL_NODE_PINS',
      updates: [
        { sourceCanvasId, sourceNodeIds: [sourceA], pinned: true },
        { sourceCanvasId, sourceNodeIds: [sourceA], pinned: false },
      ],
      prepared: prepared([
        {
          sourceNodeId: sourceA,
          nodeRefId: 'node-ref-a' as CanvasNodeId,
          pinned: true,
        },
      ]),
    };
    const output = run(command);
    expect(output.commandResults[0]).toMatchObject({
      applied: false,
      reason: 'conflict',
    });
    expect(output.writeResult.nodes).toEqual([portal()]);
  });

  it('deduplicates exact requests and is idempotent', () => {
    const command = pinCommand(
      [sourceA, sourceA],
      prepared([
        {
          sourceNodeId: sourceA,
          nodeRefId: 'node-ref-a' as CanvasNodeId,
          pinned: true,
        },
        {
          sourceNodeId: sourceA,
          nodeRefId: 'node-unused' as CanvasNodeId,
          pinned: true,
        },
      ]),
    );
    const first = run(command);
    expect(
      first.writeResult.nodes.filter((node) => node.type === 'nodeRef'),
    ).toHaveLength(1);
    expect(
      first.writeResult.nodes.find((node) => node.type === 'nodeRef')?.data,
    ).toEqual({
      type: 'nodeRef',
      target: { canvasId: sourceCanvasId, nodeId: sourceA },
    });

    const second = run(command, first.writeResult.nodes);
    expect(second.commandResults[0]).toMatchObject({
      applied: false,
      reason: 'no-op',
    });
    expect(second.writeResult.nodes).toBe(first.writeResult.nodes);
  });

  it('inherits drag locking from a locked Portal', () => {
    const lockedPortal = {
      ...portal(),
      data: {
        type: 'canvasRef' as const,
        targetCanvasId: sourceCanvasId,
        locked: true,
      },
    };
    const output = run(
      pinCommand(
        [sourceA],
        prepared([
          {
            sourceNodeId: sourceA,
            nodeRefId: 'node-ref-a' as CanvasNodeId,
            pinned: true,
          },
        ]),
      ),
      [lockedPortal],
    );
    const nodeRef = output.writeResult.nodes.find(
      (node) => node.type === 'nodeRef',
    );

    expect(nodeRef).toMatchObject({
      draggable: false,
      data: { __dragDisabledByFrameLock: true },
    });
  });

  it('propagates an ancestor lock through a fresh frameRef subtree', () => {
    const frameSource = 'node-source-frame' as CanvasNodeId;
    const frameRefId = 'node-frame-ref' as CanvasNodeId;
    const childRefId = 'node-child-ref' as CanvasNodeId;
    const lockedPortal = {
      ...portal(),
      data: {
        type: 'canvasRef' as const,
        targetCanvasId: sourceCanvasId,
        locked: true,
      },
    };
    const output = run(
      pinCommand([frameSource], {
        pins: [
          {
            sourceCanvasId,
            sourceNodeId: frameSource,
            portalId,
            nodeRefId: frameRefId,
            referenceType: 'frameRef',
            parentRefId: portalId,
            pinned: true,
          },
          {
            sourceCanvasId,
            sourceNodeId: sourceA,
            portalId,
            nodeRefId: childRefId,
            referenceType: 'nodeRef',
            parentRefId: frameRefId,
            position: { x: 20, y: 30 },
            pinned: true,
          },
        ],
        sourcePositions: [
          {
            sourceCanvasId,
            sourceNodeId: frameSource,
            position: { x: 0, y: 0 },
          },
        ],
      }),
      [lockedPortal],
    );

    for (const id of [frameRefId, childRefId]) {
      expect(
        output.writeResult.nodes.find((node) => node.id === id),
      ).toMatchObject({
        draggable: false,
        data: { __dragDisabledByFrameLock: true },
      });
    }
  });

  it('adopts an existing reference into a locked frameRef', () => {
    const outerSource = 'node-source-outer' as CanvasNodeId;
    const innerSource = 'node-source-inner' as CanvasNodeId;
    const outerRefId = 'node-outer-ref' as CanvasNodeId;
    const innerRefId = 'node-inner-ref' as CanvasNodeId;
    const childRefId = 'node-child-ref' as CanvasNodeId;
    const nodes: CanvasNode[] = [
      portal(),
      {
        id: innerRefId,
        type: 'frameRef',
        parentId: portalId,
        position: { x: 40, y: 60 },
        style: { width: 240, height: 180 },
        data: {
          type: 'frameRef',
          target: { canvasId: sourceCanvasId, nodeId: innerSource },
          locked: true,
        },
      },
      {
        id: childRefId,
        type: 'nodeRef',
        parentId: portalId,
        position: { x: 320, y: 220 },
        style: { width: 180, height: 96 },
        data: {
          type: 'nodeRef',
          target: { canvasId: sourceCanvasId, nodeId: sourceA },
        },
      },
    ];
    const childAbsoluteBefore = getAbsolutePosition(
      nodes as NestableNode[],
      childRefId,
    );
    const output = run(
      pinCommand([outerSource], {
        pins: [
          {
            sourceCanvasId,
            sourceNodeId: outerSource,
            portalId,
            nodeRefId: outerRefId,
            referenceType: 'frameRef',
            parentRefId: portalId,
            pinned: true,
          },
          {
            sourceCanvasId,
            sourceNodeId: innerSource,
            portalId,
            nodeRefId: innerRefId,
            referenceType: 'frameRef',
            parentRefId: outerRefId,
            position: { x: 40, y: 60 },
            pinned: true,
          },
          {
            sourceCanvasId,
            sourceNodeId: sourceA,
            portalId,
            nodeRefId: childRefId,
            referenceType: 'nodeRef',
            parentRefId: innerRefId,
            position: { x: 20, y: 30 },
            pinned: true,
          },
        ],
        sourcePositions: [
          {
            sourceCanvasId,
            sourceNodeId: outerSource,
            position: { x: 0, y: 0 },
          },
        ],
      }),
      nodes,
    );
    const result = output.writeResult.nodes as NestableNode[];
    const child = result.find((node) => node.id === childRefId);

    expect(output.commandResults[0]).toMatchObject({ applied: true });
    expect(child).toMatchObject({
      parentId: innerRefId,
      draggable: false,
      data: { __dragDisabledByFrameLock: true },
    });
    expect(getAbsolutePosition(result, childRefId)).toEqual(
      childAbsoluteBefore,
    );
  });

  it('preserves an inner frameRef lock when its outer frameRef is unlocked', () => {
    const outerRefId = 'node-outer-ref' as CanvasNodeId;
    const innerRefId = 'node-inner-ref' as CanvasNodeId;
    const childRefId = 'node-child-ref' as CanvasNodeId;
    const nodes: CanvasNode[] = [
      portal(),
      {
        id: outerRefId,
        type: 'frameRef',
        parentId: portalId,
        position: { x: 20, y: 30 },
        data: {
          type: 'frameRef',
          target: { canvasId: sourceCanvasId, nodeId: 'node-source-outer' },
        },
      },
      {
        id: innerRefId,
        type: 'frameRef',
        parentId: outerRefId,
        position: { x: 20, y: 30 },
        data: {
          type: 'frameRef',
          target: { canvasId: sourceCanvasId, nodeId: 'node-source-inner' },
        },
      },
      {
        id: childRefId,
        type: 'nodeRef',
        parentId: innerRefId,
        position: { x: 20, y: 30 },
        data: {
          type: 'nodeRef',
          target: { canvasId: sourceCanvasId, nodeId: sourceA },
        },
      },
    ];
    const lockInner = run(
      {
        type: 'SET_NODE_LOCKED',
        items: [{ nodeId: innerRefId, locked: true }],
      },
      nodes,
    ).writeResult.nodes;
    const lockOuter = run(
      {
        type: 'SET_NODE_LOCKED',
        items: [{ nodeId: outerRefId, locked: true }],
      },
      lockInner,
    ).writeResult.nodes;
    const unlockOuter = run(
      {
        type: 'SET_NODE_LOCKED',
        items: [{ nodeId: outerRefId, locked: false }],
      },
      lockOuter,
    ).writeResult.nodes;

    expect(unlockOuter.find((node) => node.id === innerRefId)).toMatchObject({
      draggable: false,
      data: { locked: true },
    });
    expect(unlockOuter.find((node) => node.id === childRefId)).toMatchObject({
      draggable: false,
      data: { __dragDisabledByFrameLock: true },
    });
  });

  it('keeps existing World positions stable and places in input order', () => {
    const command = pinCommand(
      [sourceA, sourceB],
      prepared([
        {
          sourceNodeId: sourceA,
          nodeRefId: 'node-ref-a' as CanvasNodeId,
          pinned: true,
        },
        {
          sourceNodeId: sourceB,
          nodeRefId: 'node-ref-b' as CanvasNodeId,
          pinned: true,
        },
      ]),
    );
    const together = run(command).writeResult.nodes as NestableNode[];
    const firstOnly = run(
      pinCommand(
        [sourceA],
        prepared([
          {
            sourceNodeId: sourceA,
            nodeRefId: 'node-ref-a' as CanvasNodeId,
            pinned: true,
          },
        ]),
      ),
    ).writeResult.nodes as NestableNode[];

    expect(getAbsolutePosition(together, 'node-ref-a')).toEqual(
      getAbsolutePosition(firstOnly, 'node-ref-a'),
    );
    const a = getAbsolutePosition(together, 'node-ref-a');
    const b = getAbsolutePosition(together, 'node-ref-b');
    expect(a && b && b.x > a.x && b.y > a.y).toBe(true);
    expect(run(command).writeResult.nodes).toEqual(together);
  });

  it('hugs geometry while preserving direct-child absolute positions', () => {
    const pinned = run(
      pinCommand(
        [sourceA, sourceB],
        prepared([
          {
            sourceNodeId: sourceA,
            nodeRefId: 'node-ref-a' as CanvasNodeId,
            pinned: true,
          },
          {
            sourceNodeId: sourceB,
            nodeRefId: 'node-ref-b' as CanvasNodeId,
            pinned: true,
          },
        ]),
      ),
    ).writeResult.nodes as NestableNode[];
    const portalBefore = pinned.find((node) => node.id === portalId);
    const childBefore = getAbsolutePosition(pinned, 'node-ref-a');
    if (!portalBefore || !childBefore) throw new Error('Missing Portal state');

    const moved = run(
      {
        type: 'SET_NODE_GEOMETRY',
        items: [
          {
            nodeId: 'node-ref-a' as CanvasNodeId,
            position: { x: -120, y: -80 },
          },
        ],
      },
      pinned,
    ).writeResult.nodes as NestableNode[];
    expect(getAbsolutePosition(moved, 'node-ref-a')).toEqual({
      x: portalBefore.position.x - 120,
      y: portalBefore.position.y - 80,
    });
    expect(moved.find((node) => node.id === portalId)?.position).not.toEqual(
      portalBefore.position,
    );

    const remainingBefore = getAbsolutePosition(moved, 'node-ref-b');
    const unpinned = run(
      pinCommand(
        [sourceA],
        prepared([
          {
            sourceNodeId: sourceA,
            nodeRefId: 'node-ref-a' as CanvasNodeId,
            pinned: false,
          },
        ]),
        false,
      ),
      moved,
    ).writeResult.nodes as NestableNode[];
    expect(getAbsolutePosition(unpinned, 'node-ref-b')).toEqual(
      remainingBefore,
    );
  });

  it('rejects invalid generic Portal reparenting', () => {
    const ordinary: CanvasNode = {
      id: 'node-ordinary',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { type: 'note', content: '' },
    };
    const mismatched: CanvasNode = {
      id: 'node-mismatched',
      type: 'nodeRef',
      position: { x: 0, y: 0 },
      data: {
        type: 'nodeRef',
        target: { canvasId: 'canvas-other', nodeId: 'node-other' },
      },
    };
    for (const node of [ordinary, mismatched]) {
      const output = run(
        {
          type: 'SET_NODE_PARENT',
          nodeIds: [node.id as CanvasNodeId],
          parentId: portalId,
        },
        [portal(), node],
      );
      expect(output.commandResults[0]).toMatchObject({
        applied: false,
        reason: 'invalid-parent',
      });
    }
  });
});
