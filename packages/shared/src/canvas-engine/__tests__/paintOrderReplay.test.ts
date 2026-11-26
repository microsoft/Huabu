// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What another page sees: it holds the Space as it was, receives the rows
 * of a batch, applies them and re-establishes parent-before-child. The
 * result must be the order the batch ended with on the writer.
 */

import { describe, expect, it } from 'vitest';

import { normalizeTreeOrder, type NestableNode } from '../container/tree.js';
import { applyDeltas } from '../delta.js';
import { diffCanvasState } from '../diff.js';
import { executeCanvasCommands } from '../executor.js';
import { seedNodeOrder } from '../seedOrder.js';

import type { CanvasCommand } from '../../index.js';
import type { CanvasNode } from '../interfaces.js';

function node(id: string, parentId?: string): CanvasNode {
  return {
    id,
    type: id === 'f' || id === 'g' ? 'frame' : 'note',
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
    data: {},
  } as CanvasNode;
}

function replay(prestate: CanvasNode[], commands: CanvasCommand[]) {
  const out = executeCanvasCommands(
    { source: 'ui', commands },
    { canvasId: 'c', nodes: prestate, edges: [] },
  );
  const writer = out.writeResult.nodes as CanvasNode[];
  const deltas = diffCanvasState(
    { nodes: prestate, edges: [] },
    { nodes: writer, edges: [] },
  );
  const page = normalizeTreeOrder(
    applyDeltas({ nodes: prestate, edges: [] }, deltas).nodes as NestableNode[],
  );
  return { writer, page, deltas };
}

const ids = (nodes: readonly { id: string }[]) => nodes.map((n) => n.id);

describe('a page replaying a batch ends in the writer’s paint order', () => {
  // f > fa   g > ga   a
  const prestate = seedNodeOrder(
    normalizeTreeOrder([
      node('f'),
      node('fa', 'f'),
      node('g'),
      node('ga', 'g'),
      node('a'),
    ] as NestableNode[]),
  ) as CanvasNode[];

  it('a Frame with children brought to the front', () => {
    const { writer, page, deltas } = replay(prestate, [
      { type: 'REORDER_NODES', nodeIds: ['f' as never], to: 'top' },
    ]);
    expect(ids(writer)).toEqual(['g', 'ga', 'a', 'f', 'fa']);
    expect(ids(page)).toEqual(ids(writer));
    // One row: the moved Frame's key. Its children are not rewritten.
    expect(deltas).toEqual([
      expect.objectContaining({
        type: 'REPLACE_NODE',
        next: { id: 'f', data: { paintKey: expect.any(String) } },
      }),
    ]);
  });

  it('a Frame with children sent to the back', () => {
    const { writer, page } = replay(prestate, [
      { type: 'REORDER_NODES', nodeIds: ['a' as never], to: 'bottom' },
    ]);
    expect(ids(writer)).toEqual(['a', 'f', 'fa', 'g', 'ga']);
    expect(ids(page)).toEqual(ids(writer));
  });

  it('a node moved into a Frame, and a child moved out', () => {
    const into = replay(prestate, [
      {
        type: 'SET_NODE_PARENT',
        nodeIds: ['a' as never],
        parentId: 'f' as never,
      },
    ]);
    expect(ids(into.page)).toEqual(ids(into.writer));
    expect(into.writer.find((n) => n.id === 'a')?.parentId).toBe('f');

    const out = replay(prestate, [
      { type: 'SET_NODE_PARENT', nodeIds: ['fa' as never], parentId: null },
    ]);
    expect(ids(out.page)).toEqual(ids(out.writer));
  });

  it('a created node and a deleted Frame', () => {
    const created = replay(prestate, [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'n' as never,
            nodeType: 'note',
            parentId: 'g' as never,
            position: { x: 0, y: 0 },
          },
        ],
      },
    ]);
    expect(ids(created.page)).toEqual(ids(created.writer));
    const deleted = replay(prestate, [
      { type: 'DELETE_NODES', nodeIds: ['f' as never] },
    ]);
    expect(ids(deleted.page)).toEqual(ids(deleted.writer));
  });
});
