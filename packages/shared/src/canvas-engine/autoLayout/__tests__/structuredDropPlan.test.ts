// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Preview and commit must describe the same drop.
 *
 * The drag preview lives in the shared engine and the committed drop is
 * assembled in the web resolver, so the rule for what a drop *means* —
 * which track the dragged child takes, who it displaces, what happens
 * to the cell it vacates — had been written twice. The copies drifted:
 * only the commit path compacted a row that a move emptied, so
 * releasing the last child of a row made the layout jump at the moment
 * the user let go.
 *
 * `planStructuredDrop` is now the single answer, and these tests pin
 * the cases where the two used to disagree.
 */

import { describe, it, expect } from 'vitest';

import {
  applyGridLayout,
  describeStructuredDropZone,
  planStructuredDrop,
} from '../gridLayout.js';

import type { Node } from '@xyflow/react';

const SIZE = { width: 80, height: 40 };

function makeFrame(layoutMode: string, gridCount = 2): Node {
  return {
    id: 'frame',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode, gridCount, sizing: 'hug' },
    style: { width: 400, height: 400 },
    measured: { width: 400, height: 400 },
  } as Node;
}

function makeChild(
  id: string,
  cell: { column: number; row: number },
  position: { x: number; y: number },
): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position,
    data: { frameColumn: cell.column, frameRow: cell.row },
    style: SIZE,
    measured: SIZE,
  } as Node;
}

/** Read the cells the planner resolved, as a comparable plain object. */
function cellsOf(
  plan: ReturnType<typeof planStructuredDrop>,
): Record<string, { column: number; row: number }> {
  const out: Record<string, { column: number; row: number }> = {};
  for (const [id, column] of plan.tracks) {
    out[id] = { column, row: plan.rows.get(id) ?? 0 };
  }
  return out;
}

describe('planStructuredDrop — vacated rows', () => {
  it('closes the row a move emptied', () => {
    // `solo` is the only child of row 0. Moving it into row 1 leaves
    // row 0 with nothing in it, so the rows below move up.
    const nodes = [
      makeFrame('grid'),
      makeChild('solo', { column: 0, row: 0 }, { x: 16, y: 16 }),
      makeChild('lower-left', { column: 0, row: 1 }, { x: 16, y: 72 }),
      makeChild('lower-right', { column: 1, row: 1 }, { x: 112, y: 72 }),
    ];

    const plan = planStructuredDrop(nodes, 'frame', 'grid', 2, [
      {
        nodeId: 'solo',
        target: { kind: 'into-existing', slot: 1 },
        rowTarget: { kind: 'into-existing', slot: 2 },
      },
    ]);

    expect(cellsOf(plan)).toEqual({
      'lower-left': { column: 0, row: 0 },
      'lower-right': { column: 1, row: 0 },
      solo: { column: 1, row: 1 },
    });
  });

  it('keeps rows that were already blank before the drag', () => {
    // Row 1 is deliberately empty and no child vacates a row, so
    // nothing is compacted — a blank cell is a statement in `grid`.
    const nodes = [
      makeFrame('grid'),
      makeChild('top', { column: 0, row: 0 }, { x: 16, y: 16 }),
      makeChild('bottom', { column: 0, row: 2 }, { x: 16, y: 128 }),
      makeChild('peer', { column: 1, row: 2 }, { x: 112, y: 128 }),
    ];

    const plan = planStructuredDrop(nodes, 'frame', 'grid', 2, [
      {
        nodeId: 'top',
        target: { kind: 'into-existing', slot: 1 },
        rowTarget: { kind: 'into-existing', slot: 0 },
      },
    ]);

    expect(cellsOf(plan)).toEqual({
      top: { column: 1, row: 0 },
      bottom: { column: 0, row: 2 },
      peer: { column: 1, row: 2 },
    });
  });

  it('trades places when the target cell is taken by a peer', () => {
    const nodes = [
      makeFrame('grid'),
      makeChild('mover', { column: 0, row: 0 }, { x: 16, y: 16 }),
      makeChild('occupant', { column: 1, row: 1 }, { x: 112, y: 72 }),
      makeChild('anchor', { column: 0, row: 1 }, { x: 16, y: 72 }),
    ];

    const plan = planStructuredDrop(nodes, 'frame', 'grid', 2, [
      {
        nodeId: 'mover',
        target: { kind: 'into-existing', slot: 1 },
        rowTarget: { kind: 'into-existing', slot: 1 },
      },
    ]);

    // The occupant takes the mover's old cell, so no unrelated child
    // has to shift and no row is left empty.
    expect(cellsOf(plan)).toEqual({
      mover: { column: 1, row: 1 },
      occupant: { column: 0, row: 0 },
      anchor: { column: 0, row: 1 },
    });
  });
});

describe('planStructuredDrop — opening a row', () => {
  it('pushes later rows down instead of trading places', () => {
    // Aiming between two rows has to mean "make room here". Before the
    // row axis had an `insert-new` target this collapsed into a swap
    // with whichever row the pointer was nearest, so a grid could only
    // ever be permuted, never grown along Y.
    const nodes = [
      makeFrame('grid'),
      makeChild('a', { column: 0, row: 0 }, { x: 16, y: 16 }),
      makeChild('b', { column: 1, row: 0 }, { x: 112, y: 16 }),
      makeChild('c', { column: 0, row: 1 }, { x: 16, y: 72 }),
      makeChild('mover', { column: 1, row: 1 }, { x: 112, y: 72 }),
    ];

    const plan = planStructuredDrop(nodes, 'frame', 'grid', 2, [
      {
        nodeId: 'mover',
        target: { kind: 'into-existing', slot: 0 },
        rowTarget: { kind: 'insert-new', slot: 1 },
      },
    ]);

    expect(cellsOf(plan)).toEqual({
      a: { column: 0, row: 0 },
      b: { column: 1, row: 0 },
      mover: { column: 0, row: 1 },
      c: { column: 0, row: 2 },
    });
  });

  it('yields to a track break in the same gesture', () => {
    // The dragged node is opening a column, so it lands in a column that
    // is empty by construction — breaking a row as well would only add a
    // blank stripe across the frame.
    const nodes = [
      makeFrame('grid'),
      makeChild('a', { column: 0, row: 0 }, { x: 16, y: 16 }),
      makeChild('b', { column: 1, row: 0 }, { x: 112, y: 16 }),
      makeChild('mover', { column: 1, row: 1 }, { x: 112, y: 72 }),
    ];

    const plan = planStructuredDrop(nodes, 'frame', 'grid', 2, [
      {
        nodeId: 'mover',
        target: { kind: 'insert-new', slot: 1 },
        rowTarget: { kind: 'insert-new', slot: 1 },
      },
    ]);

    expect(plan.count).toBe(3);
    expect(cellsOf(plan)).toEqual({
      a: { column: 0, row: 0 },
      b: { column: 2, row: 0 },
      mover: { column: 1, row: 1 },
    });
  });
});

describe('preview agrees with the plan', () => {
  it('previews the compacted layout, not the pre-compaction one', () => {
    const nodes = [
      makeFrame('grid'),
      makeChild('solo', { column: 0, row: 0 }, { x: 16, y: 16 }),
      makeChild('lower-left', { column: 0, row: 1 }, { x: 16, y: 72 }),
      makeChild('lower-right', { column: 1, row: 1 }, { x: 112, y: 72 }),
    ];
    const moved = { id: 'solo', x: 112, y: 128, ...SIZE };

    const zone = describeStructuredDropZone(
      nodes,
      'frame',
      { x: 152, y: 136 },
      'grid',
      2,
      moved,
    );

    // Two rows survive the drop, so the preview must show two — not the
    // three it would report if the vacated row lingered.
    expect(zone?.context.rows).toHaveLength(2);

    // And the peers' preview positions are the ones the compacted
    // layout produces.
    const compacted = applyGridLayout(
      [
        makeFrame('grid'),
        makeChild('solo', { column: 1, row: 1 }, { x: moved.x, y: moved.y }),
        makeChild('lower-left', { column: 0, row: 0 }, { x: 16, y: 72 }),
        makeChild('lower-right', { column: 1, row: 0 }, { x: 112, y: 72 }),
      ],
      'frame',
      2,
    );
    for (const entry of zone?.reflow ?? []) {
      expect({ x: entry.x, y: entry.y }).toEqual(
        compacted?.childPositions.get(entry.id),
      );
    }
  });
});
