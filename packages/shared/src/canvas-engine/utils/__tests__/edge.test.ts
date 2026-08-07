// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for obstacle-aware smart-handle selection and edge rerouting.
 */

import { describe, it, expect } from 'vitest';

import { resolveAccent } from '../../../index.js';
import {
  applyEdgeStyle,
  DEFAULT_EDGE_STROKE_TOKEN,
  getSmartHandles,
  rerouteAllEdges,
} from '../edge.js';

import type { ObstacleRect } from '../edge.js';
import type { Node, Edge } from '@xyflow/react';

// ── Helpers ────────────────────────────────────────────────────────────

/** Node factory with an explicit rendered size via `style`. */
function makeNode(
  id: string,
  x: number,
  y: number,
  w = 100,
  h = 100,
  overrides: Partial<Node> = {},
): Node {
  return {
    id,
    type: 'note',
    position: { x, y },
    data: {},
    style: { width: w, height: h },
    ...overrides,
  } as Node;
}

function makeEdge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target } as Edge;
}

describe('applyEdgeStyle — defaults', () => {
  it('renders an unstyled edge with the neutral grey palette token', () => {
    const edge = applyEdgeStyle(makeEdge('s', 't'));

    expect(edge.style?.stroke).toBe(resolveAccent(DEFAULT_EDGE_STROKE_TOKEN));
  });

  it('uses neutral grey when other edge styles omit stroke', () => {
    const edge = applyEdgeStyle(makeEdge('s', 't'), { lineStyle: 'dashed' });

    expect(edge.style?.stroke).toBe(resolveAccent(DEFAULT_EDGE_STROKE_TOKEN));
  });
});

// ── getSmartHandles: obstacle avoidance ────────────────────────────────

describe('getSmartHandles — obstacle avoidance', () => {
  it('keeps the preferred route when it is unobstructed', () => {
    const src = makeNode('s', 0, 0, 100, 100);
    const tgt = makeNode('t', 300, 0, 100, 100);
    // Obstacle well clear of the right-going corridor.
    const obstacles: ObstacleRect[] = [
      { id: 'o', x: 0, y: 400, w: 100, h: 100 },
    ];
    expect(getSmartHandles(src, tgt, obstacles)).toEqual({
      sourceHandle: 'right-source',
      targetHandle: 'left-target',
    });
  });

  it('reroutes to a perpendicular side when the direct route is blocked', () => {
    const src = makeNode('s', 0, 0, 100, 100);
    const tgt = makeNode('t', 300, 0, 100, 100);
    // Thin bar hugging the source on the y=50 line: blocks the straight
    // right→left corridor but sits clear of the diagonal top/bottom routes.
    const obstacles: ObstacleRect[] = [
      { id: 'blocker', x: 110, y: 44, w: 40, h: 12 },
    ];
    const result = getSmartHandles(src, tgt, obstacles);
    expect(result).not.toEqual({
      sourceHandle: 'right-source',
      targetHandle: 'left-target',
    });
  });

  it('ignores obstacles whose id matches an endpoint', () => {
    const src = makeNode('s', 0, 0, 100, 100);
    const tgt = makeNode('t', 300, 0, 100, 100);
    // A "blocker" that is actually the target itself must be skipped.
    const obstacles: ObstacleRect[] = [
      { id: 't', x: 180, y: 20, w: 60, h: 60 },
    ];
    expect(getSmartHandles(src, tgt, obstacles)).toEqual({
      sourceHandle: 'right-source',
      targetHandle: 'left-target',
    });
  });

  it('falls back to the least-obstructed route when all are blocked', () => {
    const src = makeNode('s', 0, 0, 100, 100);
    const tgt = makeNode('t', 300, 0, 100, 100);
    // Surround so every straight connector hits at least one obstacle;
    // the function must still return a valid pair (least-bad).
    const obstacles: ObstacleRect[] = [
      { id: 'b1', x: 180, y: 20, w: 60, h: 60 },
      { id: 'b2', x: 120, y: 120, w: 60, h: 60 },
      { id: 'b3', x: 120, y: -180, w: 60, h: 60 },
    ];
    const result = getSmartHandles(src, tgt, obstacles);
    expect(result.sourceHandle).toMatch(/-source$/);
    expect(result.targetHandle).toMatch(/-target$/);
  });

  it('prefers an L-shaped route for diagonal layouts with an obstruction', () => {
    // Real-world case: left-yellow node at top-left, right-yellow at bottom-right,
    // small "ooo" node in between blocking the naive bottom→top direct route.
    // Layout from screenshot (approximate coordinates):
    //   src  (left-yellow):  x=50,  y=50,   w=350, h=250
    //   tgt  (right-yellow): x=650, y=300,  w=400, h=450
    //   blocker ("ooo"):     x=270, y=350,  w=300, h=56
    const src = makeNode('src', 50, 50, 350, 250);
    const tgt = makeNode('tgt', 650, 300, 400, 450);
    const blocker: ObstacleRect = {
      id: 'blocker',
      x: 270,
      y: 350,
      w: 300,
      h: 56,
    };

    const result = getSmartHandles(src, tgt, [blocker]);
    // The natural route is right-source → top-target (L-shaped), avoiding
    // the blocker that sits between the two nodes.
    expect(result).toEqual({
      sourceHandle: 'right-source',
      targetHandle: 'top-target',
    });
  });

  it('does not loop around when nodes are diagonal and unobstructed', () => {
    // Regression: a far-away obstacle (irrelevant to this edge) must not
    // push the router into an absurd long detour. Lower-left source,
    // upper-right target — the short clean diagonal must win.
    const src = makeNode('src', 110, 535, 210, 55);
    const tgt = makeNode('tgt', 590, 215, 310, 155);
    // Obstacle nowhere near the corridor between the two nodes.
    const faraway: ObstacleRect = { id: 'x', x: -2000, y: -2000, w: 50, h: 50 };

    const result = getSmartHandles(src, tgt, [faraway]);
    // Shortest connector = facing sides (source right → target left); the
    // source handle must face toward the target, never away (no loop).
    expect(result.sourceHandle).toBe('right-source');
    expect(result.targetHandle).toBe('left-target');
  });

  it('connects to the facing side of a tall node, not its near corner', () => {
    // Regression for the C→D screenshot case: a short, wide source sits to
    // the left of a TALL target. The tall node's left-side midpoint anchor
    // is far down, so a pure shortest-path scorer would pick the (slightly
    // shorter) top corner and route the edge upward — unnatural. The facing
    // bias must keep it on the directly-facing left side instead.
    const src = makeNode('src', 110, 285, 210, 135);
    const tgt = makeNode('tgt', 390, 285, 135, 430);
    // Pass the two nodes themselves as obstacles; they are skipped by id, so
    // this exercises the pure facing tie-break with no real obstruction.
    const obstacles: ObstacleRect[] = [
      { id: 'src', x: 110, y: 285, w: 210, h: 135 },
      { id: 'tgt', x: 390, y: 285, w: 135, h: 430 },
    ];

    const result = getSmartHandles(src, tgt, obstacles);
    expect(result).toEqual({
      sourceHandle: 'right-source',
      targetHandle: 'left-target',
    });
  });

  it('exits the bottom of a node stacked above a tall target', () => {
    // Regression for the B→D screenshot case: the source sits above and to
    // the right of a TALL target, overlapping it horizontally. Because the
    // source's left edge is almost vertically aligned with the target's top,
    // a pure shortest-path scorer prefers left-source → top-target (a short
    // near-vertical line that exits sideways with an ugly hook). Since the
    // nodes are clearly stacked vertically, the router must exit the bottom.
    const src = makeNode('src', 480, 170, 260, 95);
    const tgt = makeNode('tgt', 420, 292, 135, 358);
    const obstacles: ObstacleRect[] = [
      { id: 'src', x: 480, y: 170, w: 260, h: 95 },
      { id: 'tgt', x: 420, y: 292, w: 135, h: 358 },
    ];

    const result = getSmartHandles(src, tgt, obstacles);
    expect(result).toEqual({
      sourceHandle: 'bottom-source',
      targetHandle: 'top-target',
    });
  });

  it('routes around a small node on the diagonal using the elbow path', () => {
    // Regression for the A→C screenshot case: a small node sits almost on
    // the straight diagonal between a lower-left source and an upper-right
    // target. The rendered edge is curved (it leaves each handle along its
    // normal), so an L-route exits right then turns up — clearing the
    // blocker. A straight-chord obstacle test would wrongly penalise that
    // L-route and fall back to a shorter line that cuts through the blocker.
    const src = makeNode('src', 30, 205, 165, 65);
    const tgt = makeNode('tgt', 290, 55, 170, 95);
    const blocker: ObstacleRect = { id: 'b', x: 195, y: 135, w: 85, h: 40 };

    const result = getSmartHandles(src, tgt, [blocker]);
    // Exit the source's right side and enter the target's bottom: the elbow
    // (right → up) goes around the blocker instead of through it.
    expect(result).toEqual({
      sourceHandle: 'right-source',
      targetHandle: 'bottom-target',
    });
  });
});

// ── rerouteAllEdges ────────────────────────────────────────────────────

describe('rerouteAllEdges', () => {
  it('returns the same array reference when nothing changes', () => {
    const nodes = [makeNode('s', 0, 0), makeNode('t', 300, 0)];
    const edges = [
      {
        ...makeEdge('s', 't'),
        sourceHandle: 'right-source',
        targetHandle: 'left-target',
      },
    ];
    expect(rerouteAllEdges(nodes, edges)).toBe(edges);
  });

  it('reroutes an edge around a blocking node', () => {
    const nodes = [
      makeNode('s', 0, 0, 100, 100),
      makeNode('t', 300, 0, 100, 100),
      makeNode('blocker', 110, 44, 40, 12),
    ];
    const edges = [
      {
        ...makeEdge('s', 't'),
        sourceHandle: 'right-source',
        targetHandle: 'left-target',
      },
    ];
    const out = rerouteAllEdges(nodes, edges);
    expect(out).not.toBe(edges);
    expect(out[0].sourceHandle).not.toBe('right-source');
  });

  it('does not treat frames as obstacles', () => {
    const nodes = [
      makeNode('s', 0, 0, 100, 100),
      makeNode('t', 300, 0, 100, 100),
      makeNode('f', 180, 20, 60, 60, { type: 'frame' }),
    ];
    const edges = [makeEdge('s', 't')];
    const out = rerouteAllEdges(nodes, edges);
    // Frame is ignored → the preferred horizontal route is kept.
    expect(out[0].sourceHandle).toBe('right-source');
    expect(out[0].targetHandle).toBe('left-target');
  });

  it('keeps internal frame edges facing inward despite sibling obstacles', () => {
    const frame = makeNode('frame', 0, 0, 500, 300, {
      type: 'frame',
      data: { layoutMode: 'column' },
    });
    const nodes = [
      frame,
      makeNode('s', 20, 80, 100, 100, { parentId: 'frame' }),
      makeNode('t', 320, 80, 100, 100, { parentId: 'frame' }),
      makeNode('blocker', 140, 80, 160, 100, { parentId: 'frame' }),
    ];
    const out = rerouteAllEdges(nodes, [makeEdge('s', 't')]);

    expect(out[0]).toMatchObject({
      sourceHandle: 'right-source',
      targetHandle: 'left-target',
    });
  });

  it('still routes around obstacles inside a free frame', () => {
    // Facing handles are only safe where the solver guarantees children
    // do not overlap. A `free` frame makes no such promise — its
    // children sit wherever they were dropped — so an edge between two
    // of them must still avoid whatever is in between. Applying the
    // structured shortcut to every frame silently disabled avoidance
    // for the one layout that actually needs it.
    const build = (frameData: Record<string, unknown>) => [
      makeNode('frame', 0, 0, 500, 300, { type: 'frame', data: frameData }),
      makeNode('s', 0, 0, 100, 100, { parentId: 'frame' }),
      makeNode('t', 300, 0, 100, 100, { parentId: 'frame' }),
      makeNode('blocker', 110, 44, 40, 12, { parentId: 'frame' }),
    ];

    const free = rerouteAllEdges(build({}), [makeEdge('s', 't')])[0];
    expect(free.sourceHandle).not.toBe('right-source');

    // Same geometry in a structured frame keeps the direct pair.
    const structured = rerouteAllEdges(build({ layoutMode: 'column' }), [
      makeEdge('s', 't'),
    ])[0];
    expect(structured).toMatchObject({
      sourceHandle: 'right-source',
      targetHandle: 'left-target',
    });
  });
});
