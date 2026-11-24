// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import {
  applyDeltas,
  invertDeltas,
  diffCanvasState,
  executeCanvasCommands,
  readPaintKey,
  seedNodeOrder,
  settlePaintOrder,
  stripTransientNodeFields,
  stripTransientEdgeFields,
  type Delta,
} from '../index.js';

import type { CanvasNode, CanvasEdge } from '../interfaces.js';

function note(
  id: string,
  extra: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data,
    ...extra,
  } as CanvasNode;
}

function edge(
  id: string,
  source: string,
  target: string,
  extra: Record<string, unknown> = {},
): CanvasEdge {
  return { id, source, target, ...extra } as CanvasEdge;
}

describe('diffCanvasState — runtime UI fields', () => {
  it('emits no delta when only `selected` flips on a node', () => {
    const prev = { nodes: [note('a', { selected: true })], edges: [] };
    const next = { nodes: [note('a', { selected: false })], edges: [] };
    expect(diffCanvasState(prev, next)).toEqual([]);
  });

  it('ignores dragging / measured / resizing changes', () => {
    const prev = {
      nodes: [note('a', { dragging: true, measured: { width: 1, height: 2 } })],
      edges: [],
    };
    const next = {
      nodes: [
        note('a', {
          dragging: false,
          measured: { width: 9, height: 9 },
          resizing: true,
        }),
      ],
      edges: [],
    };
    expect(diffCanvasState(prev, next)).toEqual([]);
  });

  it('still emits a REPLACE when authored content changes', () => {
    const prev = {
      nodes: [note('a', { selected: true }, { label: 'X' })],
      edges: [],
    };
    const next = {
      nodes: [note('a', { selected: false }, { label: 'Y' })],
      edges: [],
    };
    const deltas = diffCanvasState(prev, next);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].type).toBe('REPLACE_NODE');
  });

  it('emits no delta when only `selected` flips on an edge', () => {
    const prev = {
      nodes: [],
      edges: [edge('e', 'a', 'b', { selected: true })],
    };
    const next = {
      nodes: [],
      edges: [edge('e', 'a', 'b', { selected: false })],
    };
    expect(diffCanvasState(prev, next)).toEqual([]);
  });
});

describe('diffCanvasState — paint order', () => {
  /** Apply rows; the result is already in the rendered forest's order. */
  const replay = (
    state: { nodes: CanvasNode[]; edges: CanvasEdge[] },
    deltas: Delta[],
  ) => applyDeltas(state, deltas);
  const ids = (nodes: readonly CanvasNode[]) => nodes.map((node) => node.id);
  const summary = (deltas: Delta[]) =>
    deltas
      .map((delta) => {
        const entity =
          'node' in delta
            ? delta.node
            : 'edge' in delta
              ? delta.edge
              : delta.next;
        return `${delta.type} ${entity.id}`;
      })
      .sort();

  it('records a pure engine reorder as the moved node getting a new paint key', () => {
    const prev = {
      nodes: seedNodeOrder([note('node-a'), note('node-b')]),
      edges: [],
    };
    const { writeResult } = executeCanvasCommands(
      {
        source: 'agent',
        commands: [{ type: 'REORDER_NODES', nodeIds: ['node-a'], to: 'top' }],
      },
      { ...prev, canvasId: 'ordering-characterization' },
    );
    const next = { nodes: writeResult.nodes, edges: writeResult.edges };
    const deltas = diffCanvasState(prev, next);
    const replayed = applyDeltas(prev, deltas);

    expect(ids(next.nodes)).toEqual(['node-b', 'node-a']);
    // The node that was passed keeps its key and its identity.
    expect(next.nodes[0]).toBe(prev.nodes[1]);
    expect(deltas).toEqual([
      {
        type: 'REPLACE_NODE',
        nodeType: 'note',
        prev: { id: 'node-a', data: { paintKey: readPaintKey(prev.nodes[0]) } },
        next: { id: 'node-a', data: { paintKey: readPaintKey(next.nodes[1]) } },
      },
    ]);
    expect(replayed).toEqual(next);
    expect(applyDeltas(next, invertDeltas(deltas))).toEqual(prev);
  });

  it('brings two replicas that hold the same keys to the same order', () => {
    const nodes = seedNodeOrder([
      note('node-a'),
      note('node-b'),
      note('node-c'),
    ]);
    const { writeResult } = executeCanvasCommands(
      {
        source: 'ui',
        commands: [
          {
            type: 'REORDER_NODES',
            nodeIds: ['node-a'],
            to: { after: 'node-b' },
          },
        ],
      },
      { nodes, edges: [], canvasId: 'c1' },
    );
    const deltas = diffCanvasState({ nodes, edges: [] }, writeResult);
    expect(summary(deltas)).toEqual(['REPLACE_NODE node-a']);
    // The same nodes, held in a different array order by another replica.
    const other = { nodes: [nodes[2], nodes[0], nodes[1]], edges: [] };
    expect(ids(applyDeltas({ nodes, edges: [] }, deltas).nodes)).toEqual([
      'node-b',
      'node-a',
      'node-c',
    ]);
    expect(applyDeltas(other, deltas).nodes).toEqual(writeResult.nodes);
  });

  const a = note('a');
  const b = note('b');
  const c = note('c');
  const f = note('f', { type: 'frame' });
  const g = note('g', { type: 'frame', parentId: 'f' });
  const child = note('child', { parentId: 'g' });

  /**
   * `prev` with its keys, and `next` as a batch would leave it: nodes that
   * were already there keep their key, `moved` and new ones get a key for
   * the place they stand in.
   */
  const keyed = (
    prev: CanvasNode[],
    next: CanvasNode[],
    moved: string[] = [],
  ) => {
    const before = seedNodeOrder(prev);
    const keys = new Map(before.map((node) => [node.id, readPaintKey(node)]));
    const carried = next.map((node) =>
      keys.has(node.id) && !moved.includes(node.id)
        ? { ...node, data: { ...node.data, paintKey: keys.get(node.id) } }
        : node,
    );
    return {
      before: { nodes: before, edges: [] },
      after: { nodes: settlePaintOrder(carried, before), edges: [] },
    };
  };

  it.each([
    {
      name: 'insert in the middle',
      prev: [a, c],
      next: [a, b, c],
      rows: ['INSERT_NODE b'],
    },
    {
      name: 'delete and restore',
      prev: [a, b, c],
      next: [a, c],
      rows: ['DELETE_NODE b'],
    },
    {
      name: 'reparent',
      prev: [f, a, b],
      next: [f, { ...b, parentId: 'f' }, a],
      rows: ['REPLACE_NODE b'],
    },
    {
      name: 'create nested Frames',
      prev: [a],
      next: [f, g, child, a],
      rows: ['INSERT_NODE child', 'INSERT_NODE f', 'INSERT_NODE g'],
    },
    {
      name: 'delete nested Frames',
      prev: [f, g, child, a],
      next: [a],
      rows: ['DELETE_NODE child', 'DELETE_NODE f', 'DELETE_NODE g'],
    },
    {
      name: 'create an empty Frame',
      prev: [a],
      next: [a, f],
      rows: ['INSERT_NODE f'],
    },
    {
      name: 'reorder nested siblings',
      prev: [f, g, child, { ...b, parentId: 'f' }, a],
      next: [f, { ...b, parentId: 'f' }, g, child, a],
      moved: ['b'],
      rows: ['REPLACE_NODE b'],
    },
  ])(
    '$name rewrites only the nodes it touches and round-trips',
    ({ prev, next, moved, rows }) => {
      const { before, after } = keyed(prev, next, moved);
      expect(ids(after.nodes)).toEqual(ids(next));
      const deltas = diffCanvasState(before, after);
      expect(summary(deltas)).toEqual(rows);
      expect(replay(before, deltas)).toEqual(after);
      expect(replay(after, invertDeltas(deltas))).toEqual(before);
    },
  );

  it('carries a reorder as a change of paintKey and nothing else', () => {
    const { before, after } = keyed(
      [f, g, child, { ...b, parentId: 'f' }, a],
      [f, { ...b, parentId: 'f' }, g, child, a],
      ['b'],
    );
    const [row] = diffCanvasState(before, after);
    expect(row).toMatchObject({ type: 'REPLACE_NODE' });
    if (row.type !== 'REPLACE_NODE') return;
    expect(Object.keys(row.next)).toEqual(['id', 'data']);
    expect(Object.keys(row.next.data ?? {})).toEqual(['paintKey']);
  });

  it('preserves rendered forest order rather than legacy cross-parent interleaving', () => {
    const { before, after } = keyed(
      [f, a, g, c, child],
      [a, f, g, child, c],
      ['f'],
    );
    const deltas = diffCanvasState(before, after);
    expect(summary(deltas)).toEqual(['REPLACE_NODE f']);
    expect(replay(before, deltas)).toEqual(after);
    expect(replay(after, invertDeltas(deltas))).toEqual({
      nodes: before.nodes,
      edges: [],
    });
  });

  it('does not touch paint keys for geometry, UI fields, or a no-op', () => {
    const { before } = keyed([a, b], [a, b]);
    expect(diffCanvasState(before, before)).toEqual([]);
    const after = {
      nodes: [
        { ...before.nodes[0], position: { x: 30, y: 10 }, selected: true },
        before.nodes[1],
      ],
      edges: [],
    };
    const deltas = diffCanvasState(before, after);
    expect(deltas).toEqual([
      {
        type: 'REPLACE_NODE',
        nodeType: 'note',
        prev: { id: 'a', position: { x: 0, y: 0 } },
        next: { id: 'a', position: { x: 30, y: 10 } },
      },
    ]);
    expect(applyDeltas(before, deltas).nodes).toEqual([
      { ...before.nodes[0], position: { x: 30, y: 10 } },
      before.nodes[1],
    ]);
  });

  it('keeps legacy coarse replay readable without claiming exact historical order', () => {
    const state = { nodes: [a], edges: [] };
    expect(
      applyDeltas(state, [{ type: 'REPLACE_NODE', prev: b, next: c }]),
    ).toEqual(state);
    expect(diffCanvasState(state, { nodes: [a, b], edges: [] })).toEqual([
      { type: 'INSERT_NODE', node: b },
    ]);
  });
});

describe('strip helpers', () => {
  it('stripTransientNodeFields removes only runtime fields', () => {
    const stripped = stripTransientNodeFields(
      note(
        'a',
        { selected: true, dragging: true, draggable: false },
        { label: 'X' },
      ),
    ) as Record<string, unknown>;
    expect(stripped.selected).toBeUndefined();
    expect(stripped.dragging).toBeUndefined();
    expect(stripped.draggable).toBe(false); // app-managed prop preserved
    expect(stripped.data).toEqual({ label: 'X' });
  });

  it('stripTransientEdgeFields removes selection only', () => {
    const stripped = stripTransientEdgeFields(
      edge('e', 'a', 'b', { selected: true, animated: true }),
    ) as Record<string, unknown>;
    expect(stripped.selected).toBeUndefined();
    expect(stripped.animated).toBe(true);
  });
});
