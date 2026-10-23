// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  executeCanvasCommands,
  materializeAutoHeight,
  resolveHeightMode,
} from '@huabu/shared/canvas-engine';

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
  it.each([
    { name: 'legacy auto', data: {}, height: undefined },
    {
      name: 'legacy auto with a stale measurement',
      data: { autoHeight: { intrinsicHeight: 420, measuredFor: 'old' } },
      height: undefined,
    },
    { name: 'legacy fixed', data: {}, height: 172 },
    {
      name: 'explicit auto with a numeric footprint',
      data: { heightMode: 'auto' },
      height: 388,
    },
    { name: 'explicit fixed', data: { heightMode: 'fixed' }, height: 224 },
  ])(
    'preserves $name Note height ownership and geometry after execution',
    ({ data, height }) => {
      const source = node('note', 'note', 50, 60);
      source.style = {
        width: 320,
        ...(height === undefined ? {} : { height }),
      };
      source.data = { ...source.data, ...data, content: 'Preserve my height.' };
      const before = structuredClone(source);
      const expectedMode = resolveHeightMode(source);
      const expectedSize = materializeAutoHeight(source).style;
      const plan = buildSpaceMovePlan({
        sourceNodes: [source],
        sourceEdges: [],
        destinationNodes: [],
        selectedNodeIds: [source.id],
        destinationCanvasId: 'destination',
        createSourcePreview: false,
      });
      expect(plan.commands[0]).toMatchObject({
        type: 'CREATE_NODES',
        nodes: [{ data: { heightMode: expectedMode } }],
      });
      const moved = executeCanvasCommands(
        { source: 'system', commands: plan.commands },
        { nodes: [], edges: [], canvasId: 'destination' },
      ).writeResult.nodes[0];
      expect(resolveHeightMode(moved)).toBe(expectedMode);
      expect(moved.style).toEqual(expectedSize);
      expect(moved.data.autoHeight).toEqual(source.data.autoHeight);
      expect(source).toEqual(before);
    },
  );

  it('does not carry same-Space Sigil bindings into another Space', () => {
    const ink = node('ink', 'sketch', 0, 0);
    ink.data.strokes = [
      {
        id: 'stroke-original',
        points: [
          [0, 0],
          [20, 20],
        ],
        color: 'black',
        size: 2,
        createdAt: 1,
        resourceBinding: {
          id: 'binding',
          targetNodeId: 'source-pdf',
          targetType: 'pdf',
          label: 'Paper',
          fingerprint: '1234567890abcdef',
          strokeIds: ['stroke-original', 's2', 's3', 's4'],
        },
      },
    ];
    const plan = buildSpaceMovePlan({
      sourceNodes: [ink],
      sourceEdges: [],
      destinationNodes: [],
      selectedNodeIds: [ink.id],
      destinationCanvasId: 'destination',
      createSourcePreview: false,
    });
    expect(plan.commands[0]).toMatchObject({
      type: 'CREATE_NODES',
      nodes: [
        {
          data: {
            strokes: [
              {
                id: expect.not.stringMatching(/^stroke-original$/),
                points: [
                  [0, 0],
                  [20, 20],
                ],
                resourceBinding: undefined,
              },
            ],
          },
        },
      ],
    });
    expect(ink.data.strokes).toMatchObject([
      { resourceBinding: { id: 'binding' } },
    ]);
  });
  it('deduplicates selected Frame descendants and preserves local geometry', () => {
    const frame = node('frame-a', 'frame', 50, 60);
    const child = node('node-a', 'note', 10, 20, frame.id);
    const plan = buildSpaceMovePlan({
      sourceNodes: [frame, child],
      sourceEdges: [],
      destinationNodes: [],
      selectedNodeIds: [frame.id, child.id],
      destinationCanvasId: 'destination',
      createSourcePreview: true,
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
    expect(plan.sourceCommands[1]).toMatchObject({
      type: 'CREATE_NODES',
      nodes: [
        {
          id: plan.sourcePreviewNodeId,
          nodeType: 'spacePreview',
          data: { targetCanvasId: 'destination' },
          position: { x: 50, y: 60 },
          size: { width: 400, height: 120 },
        },
      ],
    });
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
      destinationCanvasId: 'destination',
      createSourcePreview: true,
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
      destinationCanvasId: 'destination',
      createSourcePreview: true,
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
        destinationCanvasId: 'destination',
        createSourcePreview: true,
      }),
    ).toThrow(SpaceMovePlanError);
  });

  it('keeps a shortcut compact regardless of the moved footprint', () => {
    const large = node('large', 'frame', -100, -200);
    large.style = { width: 5000, height: 4000 };

    const plan = buildSpaceMovePlan({
      sourceNodes: [large],
      sourceEdges: [],
      destinationNodes: [],
      selectedNodeIds: [large.id],
      destinationCanvasId: 'destination',
      createSourcePreview: true,
    });

    expect(plan.sourceCommands[1]).toMatchObject({
      type: 'CREATE_NODES',
      nodes: [
        {
          position: { x: -100, y: -200 },
          size: { width: 400, height: 120 },
        },
      ],
    });
  });

  it('omits the source Preview when it is not requested', () => {
    const moved = node('node-a', 'note', 10, 20);
    const plan = buildSpaceMovePlan({
      sourceNodes: [moved],
      sourceEdges: [],
      destinationNodes: [],
      selectedNodeIds: [moved.id],
      destinationCanvasId: 'destination',
      createSourcePreview: false,
    });

    expect(plan.sourcePreviewNodeId).toBeNull();
    expect(plan.sourceCommands).toEqual([
      { type: 'DELETE_NODES', nodeIds: [moved.id] },
    ]);
  });
});
