// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  buildAutoEdgeRoutes,
  createAutoEdgeRouteCache,
  routeAtRenderedPorts,
} from './autoEdgeRouting';

import type { Edge, Node } from '@xyflow/react';

const node = (id: string, x: number, y: number, parentId?: string): Node => ({
  id,
  type: 'note',
  position: { x, y },
  style: { width: 100, height: 100 },
  data: {},
  ...(parentId ? { parentId } : {}),
});
const edge: Edge = {
  id: 'edge',
  source: 'source',
  target: 'target',
  sourceHandle: 'right-source',
  targetHandle: 'left-target',
};

describe('rendered automatic edge routing', () => {
  it('updates when an unconnected obstacle moves without changing persisted inputs', () => {
    const nodes = [
      node('source', 0, 0),
      node('target', 600, 0),
      node('obstacle', 250, -60),
    ];
    const original = JSON.stringify({ nodes, edge });
    const before = buildAutoEdgeRoutes(nodes, [edge]).get(edge.id);
    const after = buildAutoEdgeRoutes(
      nodes.map((n) =>
        n.id === 'obstacle' ? { ...n, position: { x: 250, y: 250 } } : n,
      ),
      [edge],
    ).get(edge.id);
    expect(before?.route.status).toBe('routed');
    expect(after?.route.status).toBe('routed');
    expect(before?.route.path).not.toBe(after?.route.path);
    expect(JSON.stringify({ nodes, edge })).toBe(original);
  });

  it('uses absolute child positions and excludes their containing Frame background', () => {
    const frame: Node = {
      ...node('frame', 100, 200),
      type: 'frame',
      style: { width: 900, height: 500 },
    };
    const nodes = [
      frame,
      node('source', 0, 50, 'frame'),
      node('target', 600, 50, 'frame'),
      node('obstacle', 300, 20, 'frame'),
    ];
    const entry = buildAutoEdgeRoutes(nodes, [edge]).get(edge.id);
    expect(entry?.options.source).toEqual({ x: 200, y: 300 });
    expect(entry?.options.obstacles).toEqual([
      { x: 400, y: 220, w: 100, h: 100 },
    ]);
    expect(entry?.route.status).toBe('routed');
  });

  it('respects explicit shapes and excludes hidden nodes and edges', () => {
    const nodes = [
      node('source', 0, 0),
      node('target', 600, 0),
      { ...node('hidden', 300, 0), hidden: true },
    ];
    const entries = buildAutoEdgeRoutes(nodes, [
      edge,
      { ...edge, id: 'hidden-edge', hidden: true },
      ...(['straight', 'bezier', 'step'] as const).map((lineType) => ({
        ...edge,
        id: lineType,
        data: { edgeStyle: { lineType } },
      })),
    ]);
    expect([...entries.keys()]).toEqual(['edge']);
    expect(entries.get('edge')?.options.obstacles).toEqual([]);
  });

  it('keeps lane order stable across edge-array reordering', () => {
    const nodes = [node('source', 0, 0), node('target', 600, 0)];
    const edges = [
      { ...edge, id: 'b' },
      { ...edge, id: 'a' },
    ];
    const first = buildAutoEdgeRoutes(nodes, edges);
    const second = buildAutoEdgeRoutes(nodes, [...edges].reverse());
    expect(first.get('a')?.route.path).toBe(second.get('a')?.route.path);
    expect(first.get('b')?.route.path).toBe(second.get('b')?.route.path);
    expect(first.get('a')?.route.path).not.toBe(first.get('b')?.route.path);
  });

  it('attaches to actual renderer ports when measurement differs from the stored box', () => {
    const entry = buildAutoEdgeRoutes(
      [node('source', 0, 0), node('target', 600, 0)],
      [edge],
    ).get(edge.id);
    if (!entry) throw new Error('Missing route');
    const result = routeAtRenderedPorts(entry, {
      sourceX: 102,
      sourceY: 52,
      targetX: 599,
      targetY: 52,
      sourcePosition: 'right',
      targetPosition: 'left',
    });
    expect(result.points[0]).toEqual({ x: 102, y: 52 });
    expect(result.points[result.points.length - 1]).toEqual({ x: 599, y: 52 });
  });

  it('reuses routes for selection, z-order, content and edge decoration changes', () => {
    const cached = createAutoEdgeRouteCache();
    const nodes = [node('source', 0, 0), node('target', 600, 0)];
    const first = cached(nodes, [edge]);
    const next = cached(
      nodes.map((entry) => ({
        ...entry,
        selected: true,
        zIndex: 20,
        data: { content: 'edited' },
      })),
      [
        {
          ...edge,
          selected: true,
          zIndex: 20,
          style: { stroke: 'red' },
          data: { edgeStyle: { label: 'new label' } },
        },
      ],
    );
    expect(next).toBe(first);
    expect(cached([...nodes].reverse(), [{ ...edge }])).toBe(first);
  });

  it.each([
    ['position', (entry: Node) => ({ ...entry, position: { x: 320, y: 200 } })],
    ['parent', (entry: Node) => ({ ...entry, parentId: 'container' })],
    ['hidden', (entry: Node) => ({ ...entry, hidden: true })],
    [
      'measured size',
      (entry: Node) => ({ ...entry, measured: { width: 180, height: 140 } }),
    ],
    [
      'style size',
      (entry: Node) => ({ ...entry, style: { width: 180, height: 140 } }),
    ],
  ] as const)(
    'invalidates immediately when an obstacle changes %s',
    (_name, mutate) => {
      const cached = createAutoEdgeRouteCache();
      const nodes = [
        node('source', 0, 0),
        node('target', 600, 0),
        node('obstacle', 250, -60),
        { ...node('container', 1200, 1000), type: 'frame' },
      ];
      const first = cached(nodes, [edge]);
      const changed = cached(
        nodes.map((entry) => (entry.id === 'obstacle' ? mutate(entry) : entry)),
        [edge],
      );
      expect(changed).not.toBe(first);
      expect(changed.get(edge.id)?.route.path).not.toBe(
        first.get(edge.id)?.route.path,
      );
    },
  );

  it.each([
    ['source', { source: 'obstacle' }],
    ['target', { target: 'obstacle' }],
    ['source handle', { sourceHandle: 'bottom-source' }],
    ['target handle', { targetHandle: 'bottom-target' }],
    ['hidden', { hidden: true }],
    ['line type', { data: { edgeStyle: { lineType: 'straight' } } }],
    ['legacy type', { type: 'straight' }],
    ['stroke width', { style: { strokeWidth: 24 } }],
  ])('invalidates when an edge changes %s', (_name, patch) => {
    const cached = createAutoEdgeRouteCache();
    const nodes = [
      node('source', 0, 0),
      node('target', 600, 0),
      node('obstacle', 250, -60),
    ];
    const first = cached(nodes, [edge]);
    expect(cached(nodes, [{ ...edge, ...patch }])).not.toBe(first);
  });

  it('reuses corrected routes at identical rendered ports and refreshes moved ports', () => {
    const entry = buildAutoEdgeRoutes(
      [node('source', 0, 0), node('target', 600, 0)],
      [edge],
    ).get(edge.id);
    if (!entry) throw new Error('Missing route');
    const ports = {
      sourceX: 102,
      sourceY: 52,
      targetX: 599,
      targetY: 52,
      sourcePosition: 'right' as const,
      targetPosition: 'left' as const,
    };
    const first = routeAtRenderedPorts(entry, ports);
    expect(routeAtRenderedPorts(entry, { ...ports })).toBe(first);
    const moved = routeAtRenderedPorts(entry, { ...ports, targetY: 80 });
    expect(moved).not.toBe(first);
    expect(moved.points[moved.points.length - 1]).toEqual({ x: 599, y: 80 });
  });

  it('limits edge crowding to nearby routes while preserving every node obstacle', () => {
    const nodes = [
      node('source', 0, 0),
      node('target', 600, 0),
      node('far-source', 20000, 20000),
      node('far-target', 20600, 20000),
    ];
    const entries = buildAutoEdgeRoutes(nodes, [
      { ...edge, id: 'a-far', source: 'far-source', target: 'far-target' },
      { ...edge, id: 'b-local' },
    ]);
    expect(entries.get('b-local')?.options.occupiedSegments).toEqual([]);
    expect(entries.get('b-local')?.options.obstacles).toHaveLength(2);
  });
});
