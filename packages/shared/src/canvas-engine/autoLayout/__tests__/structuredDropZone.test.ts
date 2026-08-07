// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { FRAME_GRID_MAX_COUNT } from '../../../types/canvas/node.js';
import {
  applyGridLayout,
  describeStructuredDropZone,
  solveStructuredFrameLayout,
} from '../gridLayout.js';

import type { Node } from '@xyflow/react';

function makeFrame(layoutMode: 'column' | 'row' | 'grid'): Node {
  return {
    id: 'frame',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode, gridCount: 2 },
    style: { width: 240, height: 160 },
    measured: { width: 240, height: 160 },
  } as Node;
}

function makeChild(
  id: string,
  frameColumn: number,
  position: { x: number; y: number },
  frameRow = 0,
): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position,
    data: { frameColumn, frameRow },
    style: { width: 80, height: 40 },
    measured: { width: 80, height: 40 },
  } as Node;
}

/**
 * A `row` frame's track IS its row, so its children carry only
 * `frameRow` — writing a column would address an axis the mode has not
 * got.
 */
function makeRowChild(
  id: string,
  frameRow: number,
  position: { x: number; y: number },
): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position,
    data: { frameRow },
    style: { width: 80, height: 40 },
    measured: { width: 80, height: 40 },
  } as Node;
}

const dragged = {
  id: 'dragged',
  x: 16,
  y: 16,
  width: 80,
  height: 40,
};

/**
 * Build the post-drop fixture by hand.
 *
 * The `grid` cases below share one gesture: `dragged` leaves
 * (col 0, row 0) for column 1, which vacates row 0 entirely, so the
 * rows beneath close the gap. That compaction is what the commit path
 * has always done, and the preview now does too — these expectations
 * are spelled out rather than obtained from the planner, so they stay
 * a check on it rather than a restatement of it.
 */
function simulateGridDrop(
  nodes: Node[],
  moved: { x: number; y: number },
  cells: Record<string, { column: number; row: number }>,
): Node[] {
  return nodes.map((node) => {
    const cell = cells[node.id];
    if (!cell) return node;
    return {
      ...node,
      ...(node.id === 'dragged'
        ? { position: { x: moved.x, y: moved.y } }
        : {}),
      data: { ...node.data, frameColumn: cell.column, frameRow: cell.row },
    } as Node;
  });
}

describe('describeStructuredDropZone context', () => {
  it('reports column tracks and the frame size the drop resolves to', () => {
    const nodes = [
      makeFrame('column'),
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('column-peer', 0, { x: 16, y: 72 }),
      makeChild('other-column', 1, { x: 112, y: 16 }),
    ];

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 32, y: 30 },
      'column',
      2,
      dragged,
    );

    expect(zone?.context.axis).toBe('column');
    expect(zone?.context.tracks).toHaveLength(2);
    // Columns span the full frame height, and a masonry column frame has
    // no addressable row axis to report.
    expect(zone?.context.tracks.every((track) => track.y === 0)).toBe(true);
    expect(zone?.context.rows).toEqual([]);
    expect(zone?.context.activeTrack).toBe(0);
    expect(zone?.frameSize).toEqual(
      solveStructuredFrameLayout(nodes, 'frame')?.frameSize,
    );
  });

  it('reports the solver-projected footprint in masonry modes too', () => {
    const nodes = [
      makeFrame('column'),
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('column-peer', 1, { x: 112, y: 16 }),
    ];
    // Aim at the second column, below its existing member.
    const movedDragged = { ...dragged, x: 112, y: 80 };

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 152, y: 96 },
      'column',
      2,
      movedDragged,
    );
    const simulated = nodes.map((node) =>
      node.id === 'dragged'
        ? {
            ...node,
            position: { x: movedDragged.x, y: movedDragged.y },
            data: { ...node.data, frameColumn: 1 },
          }
        : node,
    );
    const solved = solveStructuredFrameLayout(simulated, 'frame');
    const finalPosition = solved?.childPositions.get('dragged');

    // Same contract as grid: the mark IS the committed footprint, not a
    // separately-derived caret.
    expect(finalPosition).toBeDefined();
    expect(zone).toMatchObject({
      kind: 'into-existing',
      x: finalPosition?.x,
      y: finalPosition?.y,
      width: movedDragged.width,
      height: movedDragged.height,
      frameSize: solved?.frameSize,
    });
  });

  it('uses the same track contract with swapped geometry for rows', () => {
    const nodes = [
      makeFrame('row'),
      makeRowChild('dragged', 0, { x: 16, y: 16 }),
      makeRowChild('row-peer', 0, { x: 112, y: 16 }),
      makeRowChild('other-row', 1, { x: 16, y: 72 }),
    ];

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 30, y: 32 },
      'row',
      2,
      dragged,
    );

    expect(zone?.context.axis).toBe('row');
    expect(zone?.context.tracks).toHaveLength(2);
    // A `row` frame's tracks ARE its rows, so they span the full width
    // and there is no separate row axis to report.
    expect(zone?.context.tracks.every((track) => track.x === 0)).toBe(true);
    expect(zone?.context.rows).toEqual([]);
    expect(zone?.context.activeTrack).toBe(0);
    expect(zone?.context.activeRow).toBe(-1);
    expect(zone?.frameSize).toEqual(
      solveStructuredFrameLayout(nodes, 'frame')?.frameSize,
    );
  });

  it('uses the solver result as the two-dimensional grid footprint', () => {
    const nodes = [
      makeFrame('grid'),
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('same-row', 0, { x: 16, y: 72 }, 1),
      makeChild('target-column-next-row', 1, { x: 112, y: 128 }, 2),
    ];
    const movedDragged = { ...dragged, x: 112, y: 72 };

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 152, y: 80 },
      'grid',
      2,
      movedDragged,
    );
    const simulated = simulateGridDrop(nodes, movedDragged, {
      dragged: { column: 1, row: 0 },
      'same-row': { column: 0, row: 0 },
      'target-column-next-row': { column: 1, row: 1 },
    });
    const solved = applyGridLayout(simulated, 'frame', 2);
    const finalPosition = solved?.childPositions.get('dragged');

    expect(finalPosition).toBeDefined();
    expect(zone).toMatchObject({
      x: finalPosition?.x,
      y: finalPosition?.y,
      width: movedDragged.width,
      height: movedDragged.height,
      frameSize: solved?.frameSize,
    });
    expect(zone?.context.axis).toBe('grid');
    expect(zone?.reflow).toContainEqual({
      id: 'same-row',
      ...solved!.childPositions.get('same-row')!,
    });
  });

  it('reports the simulated track structure and the targeted cell', () => {
    const nodes = [
      makeFrame('grid'),
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('same-row', 0, { x: 16, y: 72 }, 1),
      makeChild('target-column-next-row', 1, { x: 112, y: 128 }, 2),
    ];
    const movedDragged = { ...dragged, x: 112, y: 72 };

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 152, y: 80 },
      'grid',
      2,
      movedDragged,
    );
    const simulated = simulateGridDrop(nodes, movedDragged, {
      dragged: { column: 1, row: 0 },
      'same-row': { column: 0, row: 0 },
      'target-column-next-row': { column: 1, row: 1 },
    });
    const solved = applyGridLayout(simulated, 'frame', 2);

    // Bands mirror the solver's own track geometry, so the overlay can
    // outline "how many columns / rows" without re-deriving layout.
    expect(zone?.context.tracks).toEqual(
      solved?.columnTracks?.map((track) => ({
        x: track.left,
        y: 0,
        width: track.width,
        height: solved.frameSize.height,
      })),
    );
    expect(zone?.context.rows).toEqual(
      solved?.rowTracks?.map((track) => ({
        x: 0,
        y: track.top,
        width: solved.frameSize.width,
        height: track.height,
      })),
    );
    expect(zone?.context.activeTrack).toBe(1);
    expect(zone?.context.activeRow).toBe(0);
  });

  it('reports masonry tracks on the count axis only', () => {
    const nodes = [
      makeFrame('row'),
      makeRowChild('dragged', 0, { x: 16, y: 16 }),
      makeRowChild('row-peer', 0, { x: 112, y: 16 }),
      makeRowChild('other-row', 1, { x: 16, y: 72 }),
    ];

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 30, y: 32 },
      'row',
      2,
      dragged,
    );

    expect(zone?.context.tracks).toHaveLength(2);
    expect(zone?.context.rows).toEqual([]);
  });

  it('previews the compacted position when moving empties a column', () => {
    const nodes = [
      makeFrame('grid'),
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('target-column-peer', 1, { x: 112, y: 72 }, 1),
    ];
    const movedDragged = { ...dragged, x: 112 };

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 152, y: 24 },
      'grid',
      2,
      movedDragged,
    );
    const current = applyGridLayout(nodes, 'frame', 2);
    const currentTargetPosition =
      current?.childPositions.get('target-column-peer');
    const simulated = nodes.map((node) =>
      node.id === 'dragged'
        ? {
            ...node,
            position: { x: movedDragged.x, y: movedDragged.y },
            data: { ...node.data, frameColumn: 1, frameRow: 0 },
          }
        : node,
    );
    const solved = applyGridLayout(simulated, 'frame', 2);

    // Vacating column 0 compacts it away, so the drop lands at the frame
    // padding — not where the target column currently sits.
    expect(zone?.x).toBe(solved?.childPositions.get('dragged')?.x);
    expect(zone?.x).not.toBe(currentTargetPosition?.x);
  });

  it('reflows the occupied node into the source cell on swap', () => {
    const nodes = [
      makeFrame('grid'),
      makeChild('dragged', 0, { x: 16, y: 16 }, 0),
      makeChild('occupant', 1, { x: 112, y: 72 }, 1),
    ];
    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 152, y: 80 },
      'grid',
      2,
      { ...dragged, x: 112, y: 72 },
    );

    // The swap is expressed by the reflow itself — the occupant slides
    // into the cell the dragged node vacated.
    expect(zone?.reflow).toContainEqual({ id: 'occupant', x: 16, y: 16 });
  });
});

describe('describeStructuredDropZone reflow', () => {
  it('projects the simulated grid layout onto the existing children', () => {
    const nodes = [
      makeFrame('grid'),
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('same-row', 0, { x: 16, y: 72 }, 1),
      makeChild('next-row', 1, { x: 112, y: 128 }, 2),
    ];
    const movedDragged = { ...dragged, x: 112, y: 72 };

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 152, y: 80 },
      'grid',
      2,
      movedDragged,
    );

    const simulated = simulateGridDrop(nodes, movedDragged, {
      dragged: { column: 1, row: 0 },
      'same-row': { column: 0, row: 0 },
      'next-row': { column: 1, row: 1 },
    });
    const solved = applyGridLayout(simulated, 'frame', 2);

    expect(zone?.reflow.map((entry) => entry.id).sort()).toEqual([
      'next-row',
      'same-row',
    ]);
    for (const entry of zone?.reflow ?? []) {
      expect({ x: entry.x, y: entry.y }).toEqual(
        solved?.childPositions.get(entry.id),
      );
    }
  });

  it('projects the simulated column layout and never includes the dragged node', () => {
    const nodes = [
      makeFrame('column'),
      makeChild('dragged', 1, { x: 112, y: 16 }),
      makeChild('column-peer', 0, { x: 16, y: 16 }),
      makeChild('column-tail', 0, { x: 16, y: 72 }),
    ];

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 32, y: 30 },
      'column',
      2,
      { ...dragged, x: 16, y: 16 },
    );

    expect(zone?.reflow.map((entry) => entry.id)).not.toContain('dragged');
    expect(zone?.reflow.map((entry) => entry.id).sort()).toEqual([
      'column-peer',
      'column-tail',
    ]);
    // Dropping ahead of the two peers pushes them down the column.
    const tail = zone?.reflow.find((entry) => entry.id === 'column-tail');
    expect(tail?.y).toBeGreaterThan(72);
  });

  it('omits children of other frames', () => {
    const nodes = [
      makeFrame('column'),
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('peer', 0, { x: 16, y: 72 }),
      {
        id: 'outsider',
        type: 'text',
        position: { x: 400, y: 400 },
        data: {},
        style: { width: 80, height: 40 },
        measured: { width: 80, height: 40 },
      } as Node,
    ];

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 32, y: 30 },
      'column',
      2,
      dragged,
    );

    expect(zone?.reflow.map((entry) => entry.id)).toEqual(['peer']);
  });
});

/**
 * All three structured modes classify a drop against the *solved*
 * tracks now, through one shared picker. These cases pin the rules that
 * used to differ between the hand-rolled masonry mirrors and the grid
 * row axis.
 */
describe('cross-mode drop classification', () => {
  it('treats an oversized frame’s slack as room for a new track', () => {
    // The frame is far wider than its two columns of content. The old
    // masonry picker measured "past the end" from the frame's own right
    // padding, so the whole empty right-hand half resolved to the last
    // column; every mode now reads it as "make room here".
    const nodes = [
      {
        ...makeFrame('column'),
        style: { width: 800, height: 160 },
        measured: { width: 800, height: 160 },
      },
      makeChild('a', 0, { x: 16, y: 16 }),
      makeChild('b', 1, { x: 112, y: 16 }),
    ];

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 600, y: 30 },
      'column',
      2,
      dragged,
    );

    expect(zone?.kind).toBe('insert-new');
    expect(zone?.context.activeTrack).toBe(2);
  });

  it('aims the insert band at the gutter a labelled edge widened', () => {
    // A labelled edge crossing the two columns pushes them apart, so the
    // real gutter centre no longer matches the content-only spacing the
    // masonry picker used to re-derive.
    const nodes = [
      makeFrame('column'),
      makeChild('a', 0, { x: 16, y: 16 }),
      makeChild('b', 1, { x: 112, y: 16 }),
    ];
    const edges = [
      {
        id: 'labelled',
        source: 'a',
        target: 'b',
        data: { label: 'A label wide enough to spread the columns apart' },
      },
    ];

    const layout = solveStructuredFrameLayout(nodes, 'frame', 'compact', {
      edges,
    });
    const tracks = layout?.columnTracks ?? [];
    expect(tracks).toHaveLength(2);
    const gutterCentre =
      (tracks[0].left + tracks[0].width + tracks[1].left) / 2;

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: gutterCentre, y: 30 },
      'column',
      2,
      dragged,
      { edges },
    );

    expect(zone?.kind).toBe('insert-new');
    expect(zone?.context.activeTrack).toBe(1);
  });

  it('stops promising a new track once the frame is at the maximum', () => {
    // The commit path has always refused to open track 13; the masonry
    // preview used to advertise one anyway, so the dashed `+` plate
    // promised something the drop could not deliver.
    const count = FRAME_GRID_MAX_COUNT;
    const nodes: Node[] = [
      {
        ...makeFrame('column'),
        data: { layoutMode: 'column', gridCount: count },
        style: { width: 2000, height: 160 },
        measured: { width: 2000, height: 160 },
      },
      ...Array.from({ length: count }, (_, i) =>
        makeChild(`c${i}`, i, { x: 16 + i * 96, y: 16 }),
      ),
    ];

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 1900, y: 30 },
      'column',
      count,
      dragged,
    );

    expect(zone?.kind).toBe('into-existing');
    expect(zone?.context.tracks).toHaveLength(count);
  });
});
