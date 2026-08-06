// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from 'vitest';

import {
  diffCanvasState,
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
