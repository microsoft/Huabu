import { describe, expect, it } from 'vitest';

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
  frameSlot: number,
  position: { x: number; y: number },
  frameRow = 0,
): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position,
    data: { frameSlot, frameRow },
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
            data: { ...node.data, frameSlot: 1 },
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
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('row-peer', 0, { x: 112, y: 16 }),
      makeChild('other-row', 1, { x: 16, y: 72 }),
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
    const simulated = nodes.map((node) =>
      node.id === 'dragged'
        ? {
            ...node,
            position: { x: movedDragged.x, y: movedDragged.y },
            data: { ...node.data, frameSlot: 1, frameRow: 1 },
          }
        : node,
    );
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
    const simulated = nodes.map((node) =>
      node.id === 'dragged'
        ? {
            ...node,
            position: { x: movedDragged.x, y: movedDragged.y },
            data: { ...node.data, frameSlot: 1, frameRow: 1 },
          }
        : node,
    );
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
    expect(zone?.context.activeRow).toBe(1);
  });

  it('reports masonry tracks on the count axis only', () => {
    const nodes = [
      makeFrame('row'),
      makeChild('dragged', 0, { x: 16, y: 16 }),
      makeChild('row-peer', 0, { x: 112, y: 16 }),
      makeChild('other-row', 1, { x: 16, y: 72 }),
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
            data: { ...node.data, frameSlot: 1, frameRow: 0 },
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

    const simulated = nodes.map((node) =>
      node.id === 'dragged'
        ? {
            ...node,
            position: { x: movedDragged.x, y: movedDragged.y },
            data: { ...node.data, frameSlot: 1, frameRow: 1 },
          }
        : node,
    );
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
