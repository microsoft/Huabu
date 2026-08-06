// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Verifies `resolveMoveSketchStrokesToRegion` (Stage 4B stroke transfer):
 *  - SPLIT to blank canvas: source region reflows around survivors, and a
 *    new sketch region is created carrying the moved strokes,
 *  - MERGE into another region: source reflows, target absorbs the moved
 *    strokes (MERGE_NODE_DATA + SET_NODE_GEOMETRY),
 *  - single-source fully emptied → the source node is DELETEd,
 *  - cross-frame: a framed source split to top-level lands in ABSOLUTE
 *    flow coords (proves the builder accounts for the frame offset),
 *  - degrades gracefully when the source node is gone.
 */

import { describe, expect, it } from 'vitest';

import { resolveUiIntent, type UiResolverState } from '../../uiIntent';

import type { CanvasCommand, SketchStroke } from '@huabu/shared';
import type { Node } from '@xyflow/react';

function makeUi(nodes: Node[]): UiResolverState {
  return { nodes, edges: [] };
}

function stroke(id: string, points: number[][], size = 4): SketchStroke {
  return { id, points, color: '#000', size, createdAt: 0 };
}

function sketchNode(
  id: string,
  strokes: SketchStroke[],
  opts: {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    parentId?: string;
  } = {},
): Node {
  const { x = 0, y = 0, w = 100, h = 100, parentId } = opts;
  return {
    id,
    type: 'sketch',
    position: { x, y },
    width: w,
    height: h,
    measured: { width: w, height: h },
    ...(parentId ? { parentId } : {}),
    data: { type: 'sketch', strokes, initialSize: { width: w, height: h } },
  } as unknown as Node;
}

function frameNode(id: string, x: number, y: number, w = 500, h = 500): Node {
  return {
    id,
    type: 'frame',
    position: { x, y },
    width: w,
    height: h,
    measured: { width: w, height: h },
    data: {},
  } as unknown as Node;
}

function findCommand<T extends CanvasCommand['type']>(
  commands: CanvasCommand[],
  type: T,
): Extract<CanvasCommand, { type: T }> | undefined {
  return commands.find((c) => c.type === type) as
    | Extract<CanvasCommand, { type: T }>
    | undefined;
}

describe('resolveMoveSketchStrokesToRegion', () => {
  it('splits a stroke out into a new region and reflows the source', () => {
    const nodes = [
      sketchNode('a', [
        stroke('s1', [
          [10, 10],
          [20, 20],
        ]),
        stroke('s2', [
          [50, 50],
          [60, 60],
        ]),
      ]),
    ];

    const res = resolveUiIntent(
      {
        type: 'MOVE_SKETCH_STROKES_TO_REGION',
        sources: [{ nodeId: 'a', strokeIds: ['s1'] }],
        dropDelta: { dx: 200, dy: 0 },
        targetNodeId: null,
        dropPoint: { x: 210, y: 10 },
      },
      makeUi(nodes),
    );

    // Source keeps the survivor (s2), reflowed.
    const merge = findCommand(res.commands, 'MERGE_NODE_DATA');
    expect(merge?.patches[0]?.nodeId).toBe('a');
    const survivorStrokes = (
      merge?.patches[0]?.patch as { strokes?: SketchStroke[] }
    ).strokes;
    expect(survivorStrokes?.map((s) => s.id)).toEqual(['s2']);

    // A new region is created carrying the moved stroke at the drop offset.
    const create = findCommand(res.commands, 'CREATE_NODES');
    expect(create?.nodes).toHaveLength(1);
    const created = create!.nodes[0] as unknown as {
      nodeType: string;
      position: { x: number; y: number };
      parentId?: string;
      data: { strokes: SketchStroke[] };
    };
    expect(created.nodeType).toBe('sketch');
    expect(created.parentId).toBeUndefined();
    // s1 baked to flow (origin 0,0) + drop delta (200,0) = [210,10],[220,20];
    // padded by size/2 (=2) → top-left (208, 8).
    expect(created.position).toEqual({ x: 208, y: 8 });
    expect(created.data.strokes.map((s) => s.id)).toEqual(['s1']);
    expect(created.data.strokes[0].points).toEqual([
      [2, 2],
      [12, 12],
    ]);

    expect(res.trace).toEqual([]);
  });

  it('deletes the source node when every stroke is moved out', () => {
    const nodes = [
      sketchNode('a', [
        stroke('s1', [
          [10, 10],
          [20, 20],
        ]),
      ]),
    ];

    const res = resolveUiIntent(
      {
        type: 'MOVE_SKETCH_STROKES_TO_REGION',
        sources: [{ nodeId: 'a', strokeIds: ['s1'] }],
        dropDelta: { dx: 200, dy: 0 },
        targetNodeId: null,
        dropPoint: { x: 210, y: 10 },
      },
      makeUi(nodes),
    );

    const del = findCommand(res.commands, 'DELETE_NODES');
    expect(del?.nodeIds).toEqual(['a']);
    expect(findCommand(res.commands, 'CREATE_NODES')).toBeTruthy();
    // No survivor reflow when the whole node is gone.
    expect(findCommand(res.commands, 'MERGE_NODE_DATA')).toBeUndefined();
  });

  it('merges a stroke into an existing region', () => {
    const nodes = [
      sketchNode(
        'a',
        [
          stroke('s1', [
            [10, 10],
            [20, 20],
          ]),
          stroke('s2', [
            [50, 50],
            [60, 60],
          ]),
        ],
        { x: 0, y: 0 },
      ),
      sketchNode(
        'b',
        [
          stroke('t1', [
            [10, 10],
            [20, 20],
          ]),
        ],
        { x: 300, y: 0 },
      ),
    ];

    const res = resolveUiIntent(
      {
        type: 'MOVE_SKETCH_STROKES_TO_REGION',
        sources: [{ nodeId: 'a', strokeIds: ['s1'] }],
        dropDelta: { dx: 300, dy: 0 },
        targetNodeId: 'b',
        dropPoint: { x: 310, y: 10 },
      },
      makeUi(nodes),
    );

    // No new region is created on a merge.
    expect(findCommand(res.commands, 'CREATE_NODES')).toBeUndefined();

    // Target b now holds both its own stroke and the moved one.
    const merges = res.commands.filter(
      (c): c is Extract<CanvasCommand, { type: 'MERGE_NODE_DATA' }> =>
        c.type === 'MERGE_NODE_DATA',
    );
    const targetMerge = merges.find(
      (m) => (m.patches[0]?.nodeId as string) === 'b',
    );
    const targetStrokes = (
      targetMerge?.patches[0]?.patch as { strokes?: SketchStroke[] }
    ).strokes;
    expect(targetStrokes?.map((s) => s.id).sort()).toEqual(['s1', 't1']);

    // Source a keeps the survivor s2.
    const sourceMerge = merges.find(
      (m) => (m.patches[0]?.nodeId as string) === 'a',
    );
    const sourceStrokes = (
      sourceMerge?.patches[0]?.patch as { strokes?: SketchStroke[] }
    ).strokes;
    expect(sourceStrokes?.map((s) => s.id)).toEqual(['s2']);
  });

  it('splits a framed source to top-level in absolute flow coords', () => {
    const nodes = [
      frameNode('f', 1000, 1000),
      sketchNode(
        'a',
        [
          stroke('s1', [
            [10, 10],
            [20, 20],
          ]),
          stroke('s2', [
            [50, 50],
            [60, 60],
          ]),
        ],
        { x: 0, y: 0, parentId: 'f' },
      ),
    ];

    const res = resolveUiIntent(
      {
        type: 'MOVE_SKETCH_STROKES_TO_REGION',
        sources: [{ nodeId: 'a', strokeIds: ['s1'] }],
        // Move well outside the frame (x 1000..1500) to blank canvas.
        dropDelta: { dx: 600, dy: 0 },
        targetNodeId: null,
        dropPoint: { x: 1610, y: 1010 },
      },
      makeUi(nodes),
    );

    const create = findCommand(res.commands, 'CREATE_NODES');
    const created = create!.nodes[0] as unknown as {
      position: { x: number; y: number };
      parentId?: string;
    };
    // s1 absolute origin = frame (1000,1000) + local (0,0); + point (10,10)
    // + drop delta (600,0) = (1610,1010); padded by 2 → (1608, 1008).
    // A local-only (frame-unaware) builder would wrongly yield (608, ...).
    expect(created.position).toEqual({ x: 1608, y: 1008 });
    // Dropped outside the frame → top-level region.
    expect(created.parentId).toBeUndefined();
  });

  it('returns no commands when the source node is gone', () => {
    const res = resolveUiIntent(
      {
        type: 'MOVE_SKETCH_STROKES_TO_REGION',
        sources: [{ nodeId: 'ghost', strokeIds: ['s1'] }],
        dropDelta: { dx: 10, dy: 10 },
        targetNodeId: null,
        dropPoint: { x: 0, y: 0 },
      },
      makeUi([]),
    );
    expect(res.commands).toEqual([]);
    expect(res.trace).toEqual([]);
  });
});
