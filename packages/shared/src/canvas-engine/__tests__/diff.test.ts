// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import {
  applyDeltas,
  applyOrderedDeltas,
  invertDeltas,
  materializeForestOrder,
  SiblingOrderReplayError,
  isSetSiblingOrderEvent,
  diffCanvasState,
  executeCanvasCommands,
  stripTransientNodeFields,
  stripTransientEdgeFields,
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

describe('diffCanvasState — ordered replay', () => {
  it('replays a pure engine reorder exactly', () => {
    const prev = {
      nodes: [note('node-a'), note('node-b')],
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
    const deltas = diffCanvasState(prev, next, { orderVersion: 101 });
    const replayed = applyDeltas(prev, deltas);

    expect(next.nodes.map((node) => node.id)).toEqual(['node-b', 'node-a']);
    expect(deltas).toEqual([
      {
        type: 'SET_SIBLING_ORDER',
        parentId: null,
        before: ['node-a', 'node-b'],
        after: ['node-b', 'node-a'],
        orderVersion: 101,
      },
    ]);
    expect(replayed).toEqual(next);
    expect(applyDeltas(next, invertDeltas(deltas))).toEqual(prev);
  });

  const a = note('a');
  const b = note('b');
  const c = note('c');
  const f = note('f', { type: 'frame' });
  const g = note('g', { type: 'frame', parentId: 'f' });
  const child = note('child', { parentId: 'g' });
  it.each([
    {
      name: 'insert in the middle',
      prev: [a, c],
      next: [a, b, c],
      parents: [null],
    },
    {
      name: 'delete and restore',
      prev: [a, b, c],
      next: [a, c],
      parents: [null],
    },
    {
      name: 'reparent',
      prev: [f, a, b],
      next: [f, { ...b, parentId: 'f' }, a],
      parents: [null, 'f'],
    },
    {
      name: 'create nested Frames',
      prev: [a],
      next: [f, g, child, a],
      parents: [null, 'f', 'g'],
    },
    {
      name: 'delete nested Frames',
      prev: [f, g, child, a],
      next: [a],
      parents: [null, 'f', 'g'],
    },
    {
      name: 'create an empty Frame',
      prev: [a],
      next: [a, f],
      parents: [null, 'f'],
    },
    {
      name: 'reorder nested siblings',
      prev: [f, g, child, { ...b, parentId: 'f' }, a],
      next: [f, { ...b, parentId: 'f' }, g, child, a],
      parents: ['f'],
    },
  ])(
    '$name carries complete lists and round-trips',
    ({ prev, next, parents }) => {
      const before = { nodes: prev, edges: [] };
      const after = { nodes: next, edges: [] };
      const deltas = diffCanvasState(before, after, { orderVersion: 7 });
      expect(
        deltas.filter(isSetSiblingOrderEvent).map((event) => event.parentId),
      ).toEqual(parents);
      expect(applyOrderedDeltas(before, deltas)).toEqual(after);
      expect(applyOrderedDeltas(after, invertDeltas(deltas))).toEqual(before);
      expect(
        deltas
          .filter(isSetSiblingOrderEvent)
          .every((event) => event.orderVersion === 7),
      ).toBe(true);
    },
  );

  it('preserves rendered forest order rather than legacy cross-parent interleaving', () => {
    const before = { nodes: [f, a, g, c, child], edges: [] };
    const after = { nodes: [a, f, g, child, c], edges: [] };
    const deltas = diffCanvasState(before, after, { orderVersion: 4 });
    expect(applyOrderedDeltas(before, deltas)).toEqual(after);
    expect(applyOrderedDeltas(after, invertDeltas(deltas))).toEqual({
      nodes: materializeForestOrder(before.nodes),
      edges: [],
    });
  });

  it('does not manufacture order events for geometry, UI fields, or a no-op', () => {
    const before = { nodes: [a, b], edges: [] };
    expect(diffCanvasState(before, before, { orderVersion: 2 })).toEqual([]);
    const after = {
      nodes: [{ ...a, position: { x: 30, y: 10 } }, b],
      edges: [],
    };
    const deltas = diffCanvasState(before, after, { orderVersion: 2 });
    expect(deltas.map((delta) => delta.type)).toEqual(['REPLACE_NODE']);
    expect(applyOrderedDeltas(before, deltas)).toEqual(after);
  });

  it.each([
    { before: ['a', 'b'], after: ['b', 'b'] },
    { before: ['a', 'b'], after: ['b'] },
    { before: ['a', 'b'], after: ['b', 'missing'] },
    { before: ['b', 'a'], after: ['a', 'b'] },
  ])('rejects invalid or stale order atomically: %j', (lists) => {
    const state = { nodes: [a, b], edges: [] };
    const event = {
      type: 'SET_SIBLING_ORDER' as const,
      parentId: null,
      orderVersion: 3,
      ...lists,
    };
    expect(() => applyOrderedDeltas(state, [event])).toThrow(
      SiblingOrderReplayError,
    );
    expect(state.nodes).toEqual([a, b]);
  });

  it('rejects omitted membership events and invalid final topology', () => {
    const state = { nodes: [a], edges: [] };
    expect(() =>
      applyOrderedDeltas(state, [{ type: 'INSERT_NODE', node: b }]),
    ).toThrow('Missing sibling order');
    expect(() =>
      applyOrderedDeltas(state, [
        { type: 'REPLACE_NODE', prev: a, next: { ...a, parentId: 'missing' } },
      ]),
    ).toThrow('Invalid parent');
    expect(() =>
      diffCanvasState(
        state,
        { nodes: [f, { ...f }], edges: [] },
        { orderVersion: 2 },
      ),
    ).toThrow('Duplicate node');
    expect(() =>
      diffCanvasState(
        state,
        { nodes: [{ ...f, parentId: 'g' }, g], edges: [] },
        { orderVersion: 2 },
      ),
    ).toThrow('Cyclic');
  });

  it('rejects duplicate parent events and missing entity replacements', () => {
    const state = { nodes: [a, b], edges: [] };
    const event = {
      type: 'SET_SIBLING_ORDER' as const,
      parentId: null,
      before: ['a', 'b'],
      after: ['b', 'a'],
      orderVersion: 1,
    };
    expect(() => applyOrderedDeltas(state, [event, event])).toThrow(
      'duplicate',
    );
    expect(() =>
      applyOrderedDeltas(state, [
        { type: 'REPLACE_NODE', prev: c, next: c },
        event,
      ]),
    ).toThrow('Missing');
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
