// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { buildSpaceMovePlan, SpaceMovePlanError } from './space-move-plan.js';

import type { CanvasEdge, CanvasNode } from '@huabu/shared/canvas-engine';

function node(
  id: string,
  type: string,
  x: number,
  y: number,
  parentId?: string,
): CanvasNode {
  return {
    id,
    type,
    position: { x, y },
    data: { type, label: id },
    style: { width: 100, height: 80 },
    ...(parentId ? { parentId } : {}),
  };
}

describe('buildSpaceMovePlan', () => {
  it('deduplicates selected Frame descendants and preserves local geometry', () => {
    const frame = node('frame-a', 'frame', 50, 60);
    const child = node('node-a', 'note', 10, 20, frame.id);
    const plan = buildSpaceMovePlan({
      sourceNodes: [frame, child],
      sourceEdges: [],
      destinationNodes: [],
      selectedNodeIds: [frame.id, child.id],
    });

    expect(plan.rootIds).toEqual([frame.id]);
    expect(plan.movedIds).toEqual(new Set([frame.id, child.id]));
    const create = plan.commands[0];
    expect(create.type).toBe('CREATE_NODES');
    if (create.type !== 'CREATE_NODES') return;
    const movedFrame = create.nodes.find((item) => item.nodeType === 'frame');
    const movedChild = create.nodes.find((item) => item.nodeType === 'note');
    expect(movedFrame?.position).toEqual({ x: 0, y: 0 });
    expect(movedChild?.position).toEqual({ x: 10, y: 20 });
    expect(movedChild?.parentId).toBe(movedFrame?.id);
  });

  it('preserves internal edges and reports boundary edges', () => {
    const first = node('node-a', 'note', 0, 0);
    const second = node('node-b', 'note', 120, 0);
    const outside = node('node-c', 'note', 240, 0);
    const edges: CanvasEdge[] = [
      {
        id: 'edge-internal',
        source: first.id,
        target: second.id,
        data: { edgeStyle: { label: 'kept', strokeWidth: 4 } },
      },
      {
        id: 'edge-boundary',
        source: second.id,
        target: outside.id,
      },
    ];
    const plan = buildSpaceMovePlan({
      sourceNodes: [first, second, outside],
      sourceEdges: edges,
      destinationNodes: [],
      selectedNodeIds: [first.id, second.id],
    });

    expect(plan.commands[1]).toMatchObject({
      type: 'CONNECT_NODES',
      edges: [{ style: { label: 'kept', strokeWidth: 4 } }],
    });
    expect(plan.omittedBoundaryEdges).toEqual([
      {
        edgeId: 'edge-boundary',
        source: second.id,
        target: outside.id,
      },
    ]);
  });

  it('keeps Agent thread identity while assigning a fresh node id', () => {
    const agent = node('node-agent', 'question', 0, 0);
    agent.data = {
      type: 'question',
      label: 'Agent',
      threadId: 'thread-agent',
      status: 'done',
    };
    const plan = buildSpaceMovePlan({
      sourceNodes: [agent],
      sourceEdges: [],
      destinationNodes: [],
      selectedNodeIds: [agent.id],
    });

    expect(plan.movedThreadIds).toEqual(['thread-agent']);
    expect(plan.nodeIdMap.get(agent.id)).not.toBe(agent.id);
    const create = plan.commands[0];
    expect(create.type).toBe('CREATE_NODES');
    if (create.type !== 'CREATE_NODES') return;
    expect(create.nodes[0]?.data).toMatchObject({
      threadId: 'thread-agent',
      status: 'done',
    });
  });

  it('rejects managed reference nodes', () => {
    expect(() =>
      buildSpaceMovePlan({
        sourceNodes: [node('node-ref', 'nodeRef', 0, 0)],
        sourceEdges: [],
        destinationNodes: [],
        selectedNodeIds: ['node-ref'],
      }),
    ).toThrow(SpaceMovePlanError);
  });
});
