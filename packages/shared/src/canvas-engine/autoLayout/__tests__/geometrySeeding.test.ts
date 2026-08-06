// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for geometry seeding — how a structured Frame reads a
 * layout it did not produce.
 *
 * A child with no persisted track index has never been through the
 * solver: the Frame just switched out of `free`, or the child was
 * arranged by hand. Its on-screen position is the only statement of
 * intent that exists, so entering a structured mode must read the
 * arrangement off that geometry.
 *
 * Before this was in place, `column` / `row` dealt unassigned children
 * round-robin into the least-full track and `grid` ordered them by node
 * id (a random UUID), so flipping the layout mode scattered whatever
 * the user had arranged — and, for `grid`, did so irreversibly, because
 * the shuffled rows were persisted and the rendered Y positions that
 * `column` sorts by had already been overwritten.
 */

import { describe, it, expect } from 'vitest';

import {
  applyColumnLayout,
  applyGridLayout,
  applyRowLayout,
  applyStructuredFrameRelayout,
  gridRowCeiling,
  type FrameGridLayoutResult,
} from '../gridLayout.js';

import type { Node } from '@xyflow/react';

function makeFrame(layoutMode: string, gridCount: number): Node {
  return {
    id: 'f',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode, gridCount, sizing: 'hug' },
    style: { width: 900, height: 900 },
    measured: { width: 900, height: 900 },
  } as Node;
}

/** A child with NO persisted track fields, as `free` mode leaves it. */
function freeChild(
  id: string,
  x: number,
  y: number,
  size: { width: number; height: number } = { width: 100, height: 50 },
): Node {
  return {
    id,
    type: 'text',
    parentId: 'f',
    position: { x, y },
    style: size,
    measured: size,
    data: {},
  } as Node;
}

/** A child that already carries a persisted cell. */
function placedChild(
  id: string,
  x: number,
  y: number,
  cell: { frameColumn?: number; frameRow?: number },
): Node {
  return { ...freeChild(id, x, y), data: cell } as Node;
}

/** Unwrap a solver result, failing loudly instead of threading `null`. */
function solved(result: FrameGridLayoutResult | null): FrameGridLayoutResult {
  if (!result) throw new Error('solver returned null');
  return result;
}

/** Group node ids by their assigned track, in track order. */
function groupByTrack(result: FrameGridLayoutResult): string[][] {
  const out: string[][] = [];
  for (const [id, track] of result.slotAssignments) {
    (out[track] ??= []).push(id);
  }
  return out.map((ids) => (ids ?? []).slice().sort());
}

/** Read a solved row assignment, failing loudly when absent. */
function rowOf(result: FrameGridLayoutResult, id: string): number {
  const row = result.rowAssignments?.get(id);
  if (row === undefined) throw new Error(`no row for "${id}"`);
  return row;
}

/** Read a solved Y origin, failing loudly when absent. */
function yOf(result: FrameGridLayoutResult, id: string): number {
  const position = result.childPositions.get(id);
  if (!position) throw new Error(`no position for "${id}"`);
  return position.y;
}

/** Read children top-to-bottom by their laid-out Y. */
function visualOrder(nodes: Node[]): string[] {
  return nodes
    .filter((node) => node.parentId === 'f')
    .slice()
    .sort((a, b) => a.position.y - b.position.y)
    .map((node) => node.id);
}

function withLayoutMode(nodes: Node[], mode: string): Node[] {
  return nodes.map((node) =>
    node.id === 'f'
      ? ({ ...node, data: { ...node.data, layoutMode: mode } } as Node)
      : node,
  );
}

describe('geometry seeding — column', () => {
  it('keeps visual columns together when their Y ranges do not interleave', () => {
    // Left group sits entirely above the right group. Round-robin
    // balancing used to interleave these into L,R,L,R... by Y.
    const nodes = [
      makeFrame('column', 2),
      freeChild('L1', 0, 0),
      freeChild('L2', 0, 60),
      freeChild('L3', 0, 120),
      freeChild('R1', 300, 400),
      freeChild('R2', 300, 460),
      freeChild('R3', 300, 520),
    ];
    const result = solved(applyColumnLayout(nodes, 'f', 2, 'fill'));
    expect(groupByTrack(result)).toEqual([
      ['L1', 'L2', 'L3'],
      ['R1', 'R2', 'R3'],
    ]);
  });

  it('keeps visual columns together when their counts are uneven', () => {
    const nodes = [
      makeFrame('column', 2),
      freeChild('L1', 0, 0),
      freeChild('L2', 0, 60),
      freeChild('L3', 0, 120),
      freeChild('R1', 300, 60),
    ];
    const result = solved(applyColumnLayout(nodes, 'f', 2, 'fill'));
    expect(groupByTrack(result)).toEqual([['L1', 'L2', 'L3'], ['R1']]);
  });

  it('resolves three visual columns into three tracks', () => {
    const nodes = [
      makeFrame('column', 3),
      freeChild('A1', 0, 0),
      freeChild('A2', 0, 200),
      freeChild('B1', 300, 100),
      freeChild('C1', 600, 0),
      freeChild('C2', 600, 100),
      freeChild('C3', 600, 200),
    ];
    const result = solved(applyColumnLayout(nodes, 'f', 3, 'fill'));
    expect(groupByTrack(result)).toEqual([
      ['A1', 'A2'],
      ['B1'],
      ['C1', 'C2', 'C3'],
    ]);
  });

  it('treats horizontally overlapping children as one column', () => {
    const nodes = [
      makeFrame('column', 2),
      freeChild('near-a', 0, 0),
      freeChild('near-b', 50, 200), // overlaps `near-a` on X
      freeChild('far', 400, 100),
    ];
    const result = solved(applyColumnLayout(nodes, 'f', 2, 'fill'));
    expect(groupByTrack(result)).toEqual([['near-a', 'near-b'], ['far']]);
  });

  it('collapses bands beyond gridCount into the last track', () => {
    // Four visual columns, but the frame is capped at two.
    const nodes = [
      makeFrame('column', 2),
      freeChild('c0', 0, 0),
      freeChild('c1', 200, 0),
      freeChild('c2', 400, 0),
      freeChild('c3', 600, 0),
    ];
    const result = solved(applyColumnLayout(nodes, 'f', 2, 'fill'));
    expect(groupByTrack(result)).toEqual([['c0'], ['c1', 'c2', 'c3']]);
  });

  it('still balances into the least-full track when some children are already assigned', () => {
    // A newcomer carries no band structure to read, so the top-up path
    // keeps its original behaviour.
    const nodes = [
      makeFrame('column', 2),
      placedChild('pinned', 0, 0, { frameColumn: 0 }),
      freeChild('newcomer', 0, 60),
    ];
    const result = solved(applyColumnLayout(nodes, 'f', 2, 'fill'));
    expect(result.slotAssignments.get('newcomer')).toBe(1);
  });
});

describe('geometry seeding — row', () => {
  it('keeps visual rows together when their X ranges do not interleave', () => {
    const nodes = [
      makeFrame('row', 2),
      freeChild('T1', 0, 0),
      freeChild('T2', 150, 0),
      freeChild('T3', 300, 0),
      freeChild('B1', 500, 300),
      freeChild('B2', 650, 300),
      freeChild('B3', 800, 300),
    ];
    const result = solved(applyRowLayout(nodes, 'f', 2, 'fill'));
    expect(groupByTrack(result)).toEqual([
      ['T1', 'T2', 'T3'],
      ['B1', 'B2', 'B3'],
    ]);
  });
});

describe('geometry seeding — grid', () => {
  it('seeds rows from vertical bands instead of node id', () => {
    // Ids are deliberately in reverse alphabetical order relative to Y,
    // which is what the id-ordered seed used to invert.
    const nodes = [
      makeFrame('grid', 1),
      freeChild('zzz-first', 0, 0),
      freeChild('mmm-second', 0, 100),
      freeChild('aaa-third', 0, 200),
    ];
    const result = solved(applyGridLayout(nodes, 'f', 1));
    expect(rowOf(result, 'zzz-first')).toBe(0);
    expect(rowOf(result, 'mmm-second')).toBe(1);
    expect(rowOf(result, 'aaa-third')).toBe(2);
  });

  it('bands rows globally so side-by-side children stay side by side', () => {
    // `A1` is tall; `A2` and `B1` sit level with each other below it.
    // Seeding per column would put `B1` (its column's first child) in
    // row 0, next to `A1`, breaking the correspondence.
    const nodes = [
      makeFrame('grid', 2),
      freeChild('A1', 0, 0, { width: 100, height: 200 }),
      freeChild('A2', 0, 220),
      freeChild('B1', 300, 220),
    ];
    const result = solved(applyGridLayout(nodes, 'f', 2));
    expect(rowOf(result, 'A1')).toBe(0);
    expect(rowOf(result, 'A2')).toBe(1);
    expect(rowOf(result, 'B1')).toBe(1);
    // Same row ⇒ same Y origin, which is what `grid` promises.
    expect(yOf(result, 'A2')).toBe(yOf(result, 'B1'));
  });

  it('survives a column -> grid -> column round trip', () => {
    let nodes: Node[] = [
      makeFrame('column', 1),
      freeChild('zzz-first', 0, 0),
      freeChild('mmm-second', 0, 100),
      freeChild('aaa-third', 0, 200),
    ];

    nodes = applyStructuredFrameRelayout(nodes, ['f']).nodes;
    const inColumn = visualOrder(nodes);

    nodes = applyStructuredFrameRelayout(withLayoutMode(nodes, 'grid'), [
      'f',
    ]).nodes;
    expect(visualOrder(nodes)).toEqual(inColumn);

    nodes = applyStructuredFrameRelayout(withLayoutMode(nodes, 'column'), [
      'f',
    ]).nodes;
    expect(visualOrder(nodes)).toEqual(inColumn);
  });

  it('does not re-seed once rows are persisted', () => {
    // Persisted rows outrank geometry, so a child dragged to a new Y
    // does not drag every peer's row membership with it.
    const nodes = [
      makeFrame('grid', 1),
      placedChild('a', 0, 900, { frameColumn: 0, frameRow: 0 }),
      placedChild('b', 0, 0, { frameColumn: 0, frameRow: 1 }),
    ];
    const result = solved(applyGridLayout(nodes, 'f', 1));
    expect(rowOf(result, 'a')).toBe(0);
    expect(rowOf(result, 'b')).toBe(1);
  });
});

describe('geometry seeding — banding does not chain', () => {
  it('does not let one tall child swallow the children below it', () => {
    // `tall` spans the whole frame vertically. Testing band membership
    // by interval overlap against a running maximum would pull `mid`
    // and `low` into `tall`'s band purely because they overlap *it* —
    // collapsing three visual rows into one. Bands are cut on the
    // leading edge instead, so each row survives.
    const nodes = [
      makeFrame('row', 3),
      freeChild('tall', 0, 0, { width: 100, height: 400 }),
      freeChild('mid', 200, 150),
      freeChild('low', 400, 300),
    ];
    const result = solved(applyRowLayout(nodes, 'f', undefined, 'compact'));
    expect(groupByTrack(result)).toEqual([['tall'], ['mid'], ['low']]);
  });

  it('absorbs the slop in a hand-made row', () => {
    // Nobody aligns by hand to the pixel; a few px of drift is one row.
    const nodes = [
      makeFrame('row', 1),
      freeChild('left', 0, 0),
      freeChild('middle', 200, 3),
      freeChild('right', 400, -2),
    ];
    const result = solved(applyRowLayout(nodes, 'f', undefined, 'compact'));
    expect(groupByTrack(result)).toEqual([['left', 'middle', 'right']]);
  });

  it('keeps a staggered masonry column from collapsing into one row', () => {
    // What `column` masonry actually produces: two independently
    // stacked columns whose cards do not line up. Switching to `row`
    // must not answer "one row".
    const nodes = [
      makeFrame('row', 3),
      freeChild('a', 0, 16, { width: 100, height: 160 }),
      freeChild('b', 200, 16),
      freeChild('d', 200, 74),
      freeChild('c', 0, 184),
    ];
    const result = solved(applyRowLayout(nodes, 'f', undefined, 'compact'));
    expect(result.effectiveCount).toBeGreaterThan(1);
    expect(groupByTrack(result)).toEqual([['a', 'b'], ['d'], ['c']]);
  });
});

describe('grid row ceiling', () => {
  it('clamps an out-of-range persisted row instead of allocating for it', () => {
    const nodes = [
      makeFrame('grid', 1),
      placedChild('only', 0, 0, { frameColumn: 0, frameRow: 300_000 }),
    ];
    const result = solved(applyGridLayout(nodes, 'f', 1));
    expect(rowOf(result, 'only')).toBe(gridRowCeiling(1));
    expect(result.rowTracks).toHaveLength(gridRowCeiling(1) + 1);
  });

  it('leaves deliberately sparse rows within the ceiling untouched', () => {
    const nodes = [
      makeFrame('grid', 1),
      placedChild('a', 0, 0, { frameColumn: 0, frameRow: 0 }),
      placedChild('b', 0, 0, { frameColumn: 0, frameRow: 2 }),
    ];
    const result = solved(applyGridLayout(nodes, 'f', 1));
    expect(rowOf(result, 'a')).toBe(0);
    expect(rowOf(result, 'b')).toBe(2);
  });
});
