// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { executeCanvasCommands } from '@huabu/shared/canvas-engine';

import { resolveUiIntent } from '../../uiIntent';

import type { Node } from '@xyflow/react';

function node(id: string, parentId?: string, type = 'note'): Node {
  return {
    id,
    type,
    parentId,
    position: { x: 0, y: 0 },
    style: { width: 400, height: 200 },
    data: { label: id, sizing: 'manual' },
  };
}

function reorder(
  nodes: Node[],
  ids: string[],
  target: string,
  position: 'before' | 'after',
) {
  const resolution = resolveUiIntent(
    { type: 'REORDER_NODES_RELATIVE', nodeIds: ids, overId: target, position },
    { nodes, edges: [] },
  );
  const result = executeCanvasCommands(
    { source: 'ui', commands: resolution.commands },
    { nodes, edges: [], canvasId: 'reorder-test' },
  );
  return { resolution, nodes: result.writeResult.nodes };
}

describe('REORDER_NODES_RELATIVE', () => {
  it.each([
    'empty-selection',
    'missing-member',
    'missing-target',
    'mixed-parents',
    'different-target-parent',
    'selected-target',
    'descendant-target',
    'locked-source',
    'locked-parent',
    'locked-ancestor',
  ])('rejects the whole reorder without commands or traces (%s)', (reason) => {
    const start = [
      node('outer', undefined, 'frame'),
      node('frame', 'outer', 'frame'),
      node('a', 'frame', 'frame'),
      node('leaf', 'a'),
      node('b', reason === 'mixed-parents' ? undefined : 'frame'),
      node(
        'target',
        reason === 'different-target-parent' ? undefined : 'frame',
      ),
    ];
    const lockedId =
      reason === 'locked-source'
        ? 'a'
        : reason === 'locked-parent'
          ? 'frame'
          : reason === 'locked-ancestor'
            ? 'outer'
            : null;
    for (const item of start) {
      if (item.id === lockedId) item.data.locked = true;
    }
    const resolution = resolveUiIntent(
      {
        type: 'REORDER_NODES_RELATIVE',
        nodeIds:
          reason === 'empty-selection'
            ? []
            : ['a', reason === 'missing-member' ? 'missing' : 'b'],
        overId:
          reason === 'missing-target'
            ? 'missing'
            : reason === 'selected-target'
              ? 'b'
              : reason === 'descendant-target'
                ? 'leaf'
                : 'target',
        position: 'after',
      },
      { nodes: start, edges: [] },
    );
    expect(resolution).toEqual({
      commands: [],
      trace: [],
      rejectionKey: 'layers.invalidFrameDrop',
    });
  });

  it('treats null and absent root parents as siblings', () => {
    const start: Node[] = JSON.parse(
      JSON.stringify([
        { ...node('a'), parentId: null },
        node('b'),
        node('target'),
      ]),
    );
    const { resolution, nodes } = reorder(start, ['a', 'b'], 'target', 'after');
    expect(resolution.rejectionKey).toBeUndefined();
    expect(nodes.map((item) => item.id)).toEqual(['target', 'a', 'b']);
  });

  it.each([
    ['before', ['a', 'c', 'b', 'd']],
    ['after', ['b', 'a', 'c', 'd']],
  ] as const)(
    'moves non-contiguous nodes %s the target in their existing order',
    (position, expected) => {
      const { resolution, nodes } = reorder(
        ['a', 'b', 'c', 'd'].map((id) => node(id)),
        ['c', 'a'],
        'b',
        position,
      );
      expect(resolution.commands).toHaveLength(1);
      expect(resolution.commands[0]).toEqual({
        type: 'REORDER_NODES',
        nodeIds: ['c', 'a'],
        to: position === 'before' ? { before: 'b' } : { after: 'b' },
      });
      expect(nodes.map((item) => item.id)).toEqual(expected);
      expect(resolution.trace).toEqual([
        {
          action: 'nodes_reordered',
          nodes: [
            { id: 'a', type: 'note', label: 'a' },
            { id: 'c', type: 'note', label: 'c' },
          ],
        },
      ]);
    },
  );

  it('reorders siblings without changing their parent or geometry', () => {
    const start = [
      node('frame', undefined, 'frame'),
      node('a', 'frame'),
      node('b', 'frame'),
      node('c', 'frame'),
    ];
    const { nodes } = reorder(start, ['a', 'c'], 'b', 'after');
    expect(nodes.map((item) => item.id)).toEqual(['frame', 'b', 'a', 'c']);
    for (const item of nodes.filter((item) => item.id !== 'frame')) {
      expect(item.parentId).toBe('frame');
      expect(item.position).toEqual({ x: 0, y: 0 });
    }
  });

  it('retains nested Frame subtrees when moving selected sibling roots', () => {
    const start = [
      node('frame', undefined, 'frame'),
      node('nested', 'frame', 'frame'),
      node('child', 'nested'),
      node('target'),
      node('other'),
    ];
    const { nodes } = reorder(start, ['frame', 'other'], 'target', 'after');
    expect(nodes.map((item) => item.id)).toEqual([
      'target',
      'frame',
      'nested',
      'child',
      'other',
    ]);
    expect(nodes.find((item) => item.id === 'child')?.parentId).toBe('nested');
  });
});
