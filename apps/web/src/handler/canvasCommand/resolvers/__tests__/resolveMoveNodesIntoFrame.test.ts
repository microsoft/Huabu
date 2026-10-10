// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  executeCanvasCommands,
  getAbsolutePosition,
} from '@huabu/shared/canvas-engine';

import { resolveUiIntent } from '../../uiIntent';

import type { Node } from '@xyflow/react';

function node(
  id: string,
  type = 'note',
  parentId?: string,
  x = 0,
  y = 0,
): Node {
  return {
    id,
    type,
    parentId,
    position: { x, y },
    style: { width: 400, height: 200 },
    data: { label: id, sizing: 'manual' },
  };
}

function resolve(
  nodes: Node[],
  nodeIds = ['b', 'a'],
  frameId = 'target',
  reorderTarget?: { nodeId: string; position: 'before' | 'after' },
) {
  return resolveUiIntent(
    { type: 'MOVE_NODES_INTO_FRAME', nodeIds, frameId, reorderTarget },
    { nodes, edges: [] },
  );
}

function execute(
  nodes: Node[],
  nodeIds?: string[],
  reorderTarget?: { nodeId: string; position: 'before' | 'after' },
) {
  const resolution = resolve(nodes, nodeIds, 'target', reorderTarget);
  const result = executeCanvasCommands(
    { source: 'ui', commands: resolution.commands },
    { nodes, edges: [], canvasId: 'move-frame-test' },
  );
  return { resolution, nodes: result.writeResult.nodes };
}

describe('MOVE_NODES_INTO_FRAME', () => {
  it('moves sibling roots together in stable order without changing their world geometry', () => {
    const start = [
      node('source', 'frame', undefined, 300, 400),
      node('a', 'note', 'source', 20, 30),
      node('b', 'note', 'source', 80, 90),
      node('target', 'frame', undefined, 900, 1000),
      node('child', 'note', 'target', 10, 20),
    ];
    const { resolution, nodes } = execute(start, ['b', 'a'], {
      nodeId: 'child',
      position: 'after',
    });
    expect(resolution.commands.map((command) => command.type)).toEqual([
      'SET_NODE_PARENT',
      'REORDER_NODES',
    ]);
    expect(resolution.commands[0]).toEqual({
      type: 'SET_NODE_PARENT',
      nodeIds: ['a', 'b'],
      parentId: 'target',
    });
    expect(
      nodes.filter((node) => node.parentId === 'target').map((node) => node.id),
    ).toEqual(['child', 'a', 'b']);
    for (const id of ['a', 'b']) {
      expect(getAbsolutePosition(nodes, id)).toEqual(
        getAbsolutePosition(start, id),
      );
    }
    expect(resolution.trace).toHaveLength(2);
  });

  it('moves nested Frame subtrees while only changing the selected roots parent', () => {
    const start = [
      node('source', 'frame'),
      node('a', 'frame', 'source', 50, 60),
      node('nested', 'frame', 'a', 10, 20),
      node('leaf', 'note', 'nested', 30, 40),
      node('b', 'note', 'source', 400, 100),
      node('target', 'frame', undefined, 900, 1000),
      node('child', 'note', 'target'),
    ];
    const { nodes } = execute(start, ['a', 'b'], {
      nodeId: 'child',
      position: 'after',
    });
    expect(nodes.map((node) => node.id)).toEqual([
      'source',
      'target',
      'child',
      'a',
      'nested',
      'leaf',
      'b',
    ]);
    expect(nodes.find((node) => node.id === 'nested')?.parentId).toBe('a');
    expect(nodes.find((node) => node.id === 'leaf')?.parentId).toBe('nested');
    expect(getAbsolutePosition(nodes, 'leaf')).toEqual(
      getAbsolutePosition(start, 'leaf'),
    );
  });

  it('supports a single source and an empty target with the same batch path', () => {
    const { resolution, nodes } = execute(
      [node('a'), node('target', 'frame')],
      ['a'],
    );
    expect(resolution.rejectionKey).toBeUndefined();
    expect(nodes.map((node) => node.id)).toEqual(['target', 'a']);
    expect(nodes.find((node) => node.id === 'a')?.parentId).toBe('target');
  });

  it.each([undefined, 'before', 'after'] as const)(
    'treats null and absent root parents as one parent for a %s insertion',
    (position) => {
      const start: Node[] = JSON.parse(
        JSON.stringify([
          { ...node('a'), parentId: null },
          node('b'),
          node('target', 'frame'),
          node('child', 'note', 'target'),
        ]),
      );
      const { resolution, nodes } = execute(
        start,
        ['a', 'b'],
        position ? { nodeId: 'child', position } : undefined,
      );
      expect(resolution.rejectionKey).toBeUndefined();
      expect(resolution.trace).toHaveLength(2);
      expect(
        nodes
          .filter((node) => node.id === 'a' || node.id === 'b')
          .map((node) => node.parentId),
      ).toEqual(['target', 'target']);
    },
  );

  it.each([
    'missing-member',
    'mixed-parents',
    'locked-target',
    'locked-ancestor',
    'locked-source',
    'cycle',
    'invalid-slot',
  ] as const)(
    'rejects the whole gesture without commands or traces (%s)',
    (reason) => {
      const start = [
        node('source', 'frame'),
        node('a', 'frame', 'source'),
        node('b', 'note', reason === 'mixed-parents' ? undefined : 'source'),
        node('outer', 'frame'),
        node('target', 'frame', reason === 'cycle' ? 'a' : 'outer'),
      ];
      if (reason === 'locked-target') start[4].data.locked = true;
      if (reason === 'locked-ancestor') start[3].data.locked = true;
      if (reason === 'locked-source') start[0].data.locked = true;
      const result = resolve(
        start,
        reason === 'missing-member' ? ['a', 'missing'] : ['a', 'b'],
        'target',
        reason === 'invalid-slot'
          ? { nodeId: 'source', position: 'after' }
          : undefined,
      );
      expect(result).toEqual({
        commands: [],
        trace: [],
        rejectionKey: 'layers.invalidFrameDrop',
      });
    },
  );

  it('reflows all moved members and remaining source children in structured Frames', () => {
    const start = [
      node('source', 'frame'),
      node('a', 'note', 'source', 0, 0),
      node('b', 'note', 'source', 500, 0),
      node('remaining', 'note', 'source', 1000, 0),
      node('target', 'frame', undefined, 2000, 2000),
      node('child', 'note', 'target'),
    ];
    start[0].data.layoutMode = 'column';
    start[0].data.gridCount = 3;
    start[4].data.layoutMode = 'row';
    start[4].data.gridCount = 1;
    const { nodes } = execute(start, ['a', 'b'], {
      nodeId: 'child',
      position: 'after',
    });
    expect(
      nodes.filter((node) => node.parentId === 'source').map((node) => node.id),
    ).toEqual(['remaining']);
    expect(
      nodes.filter((node) => node.parentId === 'target').map((node) => node.id),
    ).toEqual(['child', 'a', 'b']);
    for (const id of ['a', 'b', 'child'])
      expect(nodes.find((node) => node.id === id)?.data.frameRow).toBeTypeOf(
        'number',
      );
    expect(
      nodes.find((node) => node.id === 'remaining')?.data.frameColumn,
    ).toBe(0);
    const positions = nodes
      .filter((node) => node.parentId === 'target')
      .map((node) => `${node.position.x},${node.position.y}`);
    expect(new Set(positions).size).toBe(3);
  });
});

describe('MOVE_NODES_OUT_OF_FRAME', () => {
  function resolveOut(nodes: Node[], nodeIds = ['b', 'a'], targetId?: string) {
    return resolveUiIntent(
      {
        type: 'MOVE_NODES_OUT_OF_FRAME',
        nodeIds,
        reorderTarget: targetId
          ? { nodeId: targetId, position: 'after' }
          : undefined,
      },
      { nodes, edges: [] },
    );
  }

  it('detaches siblings and Frame subtrees in one batch while preserving world geometry and order', () => {
    const start = [
      node('source', 'frame', undefined, 300, 400),
      node('a', 'frame', 'source', 20, 30),
      node('leaf', 'note', 'a', 10, 20),
      node('b', 'note', 'source', 500, 600),
      node('remaining', 'note', 'source'),
      node('target'),
    ];
    const resolution = resolveOut(start, ['b', 'a'], 'target');
    expect(resolution.commands.map((command) => command.type)).toEqual([
      'SET_NODE_PARENT',
      'REORDER_NODES',
    ]);
    expect(resolution.commands[0]).toEqual({
      type: 'SET_NODE_PARENT',
      nodeIds: ['a', 'b'],
      parentId: null,
    });
    const { nodes } = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes: start, edges: [], canvasId: 'move-frame-test' },
    ).writeResult;
    expect(nodes.map((node) => node.id)).toEqual([
      'source',
      'remaining',
      'target',
      'a',
      'leaf',
      'b',
    ]);
    for (const id of ['a', 'b', 'leaf'])
      expect(getAbsolutePosition(nodes, id)).toEqual(
        getAbsolutePosition(start, id),
      );
    for (const id of ['a', 'b'])
      expect(nodes.find((node) => node.id === id)?.parentId).toBeUndefined();
    expect(nodes.find((node) => node.id === 'leaf')?.parentId).toBe('a');
    expect(resolution.trace.map((trace) => trace.action)).toEqual([
      'node_unframed',
      'node_unframed',
    ]);
  });

  it('supports one source without a relative target and reflows the structured source', () => {
    const start = [
      node('source', 'frame'),
      node('a', 'note', 'source'),
      node('b', 'note', 'source', 500, 0),
    ];
    start[0].data.layoutMode = 'column';
    start[0].data.gridCount = 2;
    const resolution = resolveOut(start, ['a']);
    const { nodes } = executeCanvasCommands(
      { source: 'ui', commands: resolution.commands },
      { nodes: start, edges: [], canvasId: 'move-frame-test' },
    ).writeResult;
    expect(resolution.commands).toHaveLength(1);
    expect(nodes.find((node) => node.id === 'a')?.parentId).toBeUndefined();
    expect(nodes.find((node) => node.id === 'b')?.data.frameColumn).toBe(0);
  });

  it.each([
    'empty',
    'missing-member',
    'mixed-parents',
    'already-root',
    'locked-source',
    'locked-ancestor',
    'locked-member',
    'missing-slot',
    'nested-slot',
    'moving-slot',
  ] as const)('rejects the entire root exit (%s)', (reason) => {
    const start = [
      node('outer', 'frame'),
      node('source', 'frame', 'outer'),
      node('a', 'frame', 'source'),
      node('b', 'note', reason === 'mixed-parents' ? 'outer' : 'source'),
      node('leaf', 'note', 'a'),
      node('target'),
    ];
    if (reason === 'locked-source') start[1].data.locked = true;
    if (reason === 'locked-ancestor') start[0].data.locked = true;
    if (reason === 'locked-member') start[3].data.locked = true;
    if (reason === 'already-root') {
      delete start[2].parentId;
      delete start[3].parentId;
    }
    const result = resolveOut(
      start,
      reason === 'empty'
        ? []
        : reason === 'missing-member'
          ? ['a', 'missing']
          : ['a', 'b'],
      reason === 'missing-slot'
        ? 'missing'
        : reason === 'nested-slot'
          ? 'source'
          : reason === 'moving-slot'
            ? 'leaf'
            : 'target',
    );
    expect(result).toEqual({
      commands: [],
      trace: [],
      rejectionKey: 'layers.invalidFrameDrop',
    });
  });
});
