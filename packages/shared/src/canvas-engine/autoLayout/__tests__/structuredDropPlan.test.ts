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

import type { StructuredDropRequest } from '../gridLayout.js';
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
  it.each([
    {
      shape: [
        [0, 0],
        [1, 1],
      ],
      shift: [0, 1],
      kind: 'into-existing',
    },
    {
      shape: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      shift: [1, 1],
      kind: 'into-existing',
    },
    {
      shape: [
        [0, 0],
        [0, 1],
      ],
      shift: [1, 2],
      kind: 'into-existing',
    },
    {
      shape: [
        [0, 0],
        [2, 2],
      ],
      shift: [0, 3],
      kind: 'insert-new',
    },
    {
      shape: [
        [0, 0],
        [1, 1],
      ],
      shift: [0, 0],
      kind: 'insert-new',
    },
    {
      shape: [
        [0, 0],
        [1, 1],
      ],
      shift: [0, 0],
      kind: 'into-existing',
    },
  ] as const)(
    'preserves every relative cell offset for $shape shifted $shift ($kind)',
    ({ shape, shift, kind }) => {
      const movers = shape.map(([column, row], index) =>
        makeChild(
          `m${index}`,
          { column, row },
          { x: 20 + column * 100, y: 64 + row * 60 },
        ),
      );
      const nodes = [
        makeFrame('grid', 3),
        ...movers,
        makeChild('peer', { column: 1, row: 2 }, { x: 120, y: 184 }),
        makeChild('bottom', { column: 2, row: 3 }, { x: 220, y: 244 }),
      ];
      const requests: StructuredDropRequest[] = shape.map(
        ([column, row], index) => ({
          nodeId: `m${index}`,
          target: { kind: 'into-existing', slot: column + shift[0] },
          rowTarget: { kind, slot: row + shift[1] },
        }),
      );
      const plan = planStructuredDrop(nodes, 'frame', 'grid', 3, requests);
      const cells = cellsOf(plan);
      const committedNodes = nodes.map((node) =>
        cells[node.id]
          ? {
              ...node,
              data: {
                ...node.data,
                frameColumn: cells[node.id].column,
                frameRow: cells[node.id].row,
              },
            }
          : node,
      );
      const layout = applyGridLayout(committedNodes, 'frame', plan.count);
      if (!layout) throw new Error('Missing group layout');
      expect(
        new Set(
          [...layout.slotAssignments].map(
            ([id, column]) => `${column}:${layout.rowAssignments?.get(id)}`,
          ),
        ).size,
      ).toBe(movers.length + 2);
      for (const [index, [column, row]] of shape.entries()) {
        expect(cells[`m${index}`].column - cells.m0.column).toBe(
          column - shape[0][0],
        );
        expect(cells[`m${index}`].row - cells.m0.row).toBe(row - shape[0][1]);
        expect(
          (layout.slotAssignments.get(`m${index}`) ?? 0) -
            (layout.slotAssignments.get('m0') ?? 0),
        ).toBe(column - shape[0][0]);
        expect(
          (layout.rowAssignments?.get(`m${index}`) ?? 0) -
            (layout.rowAssignments?.get('m0') ?? 0),
        ).toBe(row - shape[0][1]);
      }
      const zone = describeStructuredDropZone(
        nodes,
        'frame',
        { x: 20, y: 64 },
        'grid',
        3,
        { id: 'm0', x: 20, y: 64, ...SIZE },
        {
          target: requests[0].target,
          rowTarget: requests[0].rowTarget,
          requests,
        },
      );
      expect(zone?.placements).toHaveLength(movers.length);
      for (const entry of [
        ...(zone?.placements ?? []),
        ...(zone?.reflow ?? []),
      ]) {
        expect({ x: entry.x, y: entry.y }).toEqual(
          layout.childPositions.get(entry.id),
        );
      }
    },
  );

  it('retains empty interior columns and rows after moving a sparse group and reloading its layout', () => {
    const nodes = [
      makeFrame('grid', 3),
      makeChild('a', { column: 0, row: 0 }, { x: 20, y: 64 }),
      makeChild('b', { column: 2, row: 2 }, { x: 220, y: 184 }),
      makeChild('peer', { column: 1, row: 1 }, { x: 120, y: 124 }),
    ];
    const plan = planStructuredDrop(nodes, 'frame', 'grid', 3, [
      {
        nodeId: 'a',
        target: { kind: 'into-existing', slot: 0 },
        rowTarget: { kind: 'insert-new', slot: 3 },
      },
      {
        nodeId: 'b',
        target: { kind: 'into-existing', slot: 2 },
        rowTarget: { kind: 'insert-new', slot: 5 },
      },
    ]);
    expect((plan.rows.get('b') ?? 0) - (plan.rows.get('a') ?? 0)).toBe(2);
    const withoutPeer = nodes
      .filter((node) => node.id !== 'peer')
      .map((node) =>
        node.parentId
          ? {
              ...node,
              data: {
                frameColumn: plan.tracks.get(node.id),
                frameRow: plan.rows.get(node.id),
              },
            }
          : node,
      );
    const layout = applyGridLayout(withoutPeer, 'frame', plan.count);
    expect(layout?.slotAssignments.get('b')).toBe(2);
    expect(layout?.effectiveCount).toBe(3);
  });

  it('clamps a sparse block as a unit at the row safety bound without letting displaced peers split it', () => {
    const nodes = [
      makeFrame('grid', 2),
      makeChild('a', { column: 0, row: 0 }, { x: 20, y: 64 }),
      makeChild('b', { column: 1, row: 6 }, { x: 120, y: 424 }),
      makeChild('peer', { column: 1, row: 1 }, { x: 120, y: 124 }),
    ];
    const plan = planStructuredDrop(nodes, 'frame', 'grid', 2, [
      {
        nodeId: 'a',
        target: { kind: 'into-existing', slot: 0 },
        rowTarget: { kind: 'insert-new', slot: 2 },
      },
      {
        nodeId: 'b',
        target: { kind: 'into-existing', slot: 1 },
        rowTarget: { kind: 'insert-new', slot: 8 },
      },
    ]);
    let projected = nodes.map((node) =>
      node.parentId
        ? {
            ...node,
            data: {
              frameColumn: plan.tracks.get(node.id),
              frameRow: plan.rows.get(node.id),
            },
          }
        : node,
    );
    for (let iteration = 0; iteration < 3; iteration++) {
      const layout = applyGridLayout(projected, 'frame', plan.count);
      expect(layout?.rowAssignments?.get('a')).toBe(0);
      expect(layout?.rowAssignments?.get('b')).toBe(6);
      expect(layout?.rowAssignments?.get('peer')).toBe(8);
      projected = projected.map((node) =>
        node.parentId
          ? {
              ...node,
              data: {
                ...node.data,
                frameRow: layout?.rowAssignments?.get(node.id),
              },
              position: layout?.childPositions.get(node.id) ?? node.position,
            }
          : node,
      );
    }
  });

  it.each([7, 8])(
    'retains a source group spanning collision-overflow row %s across moves and reloads',
    (row) => {
      let nodes = [
        makeFrame('grid', 2),
        makeChild('a', { column: 0, row: 0 }, { x: 20, y: 64 }),
        makeChild('peer', { column: 1, row: row - 1 }, { x: 120, y: 424 }),
        makeChild('b', { column: 1, row }, { x: 120, y: 484 }),
      ];
      const original = applyGridLayout(nodes, 'frame', 2);
      expect(original?.rowAssignments?.get('b')).toBe(row);
      for (let move = 0; move < 3; move++) {
        const plan = planStructuredDrop(nodes, 'frame', 'grid', 2, [
          {
            nodeId: 'a',
            target: { kind: 'into-existing', slot: 0 },
            rowTarget: { kind: 'insert-new', slot: 0 },
          },
          {
            nodeId: 'b',
            target: { kind: 'into-existing', slot: 1 },
            rowTarget: { kind: 'insert-new', slot: row },
          },
        ]);
        nodes = nodes.map((node) =>
          node.parentId
            ? {
                ...node,
                data: {
                  ...node.data,
                  frameColumn: plan.tracks.get(node.id),
                  frameRow: plan.rows.get(node.id),
                },
              }
            : node,
        );
        for (let reload = 0; reload < 3; reload++) {
          const layout = applyGridLayout(nodes, 'frame', plan.count);
          if (!layout?.rowAssignments) throw new Error('Missing Grid layout');
          expect(layout.rowAssignments.get('b')).toBe(row);
          expect(layout.rowAssignments.get('a')).toBe(0);
          expect(layout.rowTracks?.length).toBeLessThanOrEqual(9);
          expect(
            new Set(
              [...layout.rowAssignments].map(
                ([id, assignedRow]) =>
                  `${layout.slotAssignments.get(id)}:${assignedRow}`,
              ),
            ).size,
          ).toBe(3);
          nodes = nodes.map((node) =>
            node.parentId
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    frameRow: layout.rowAssignments?.get(node.id),
                  },
                  position: layout.childPositions.get(node.id) ?? node.position,
                }
              : node,
          );
        }
      }
    },
  );

  it.each([
    { row: 0, kind: 'into-existing', column: 0 },
    { row: 0, kind: 'into-existing', column: 1 },
    { row: 1, kind: 'into-existing', column: 0 },
    { row: 1, kind: 'insert-new', column: 0 },
    { row: 0, kind: 'insert-new', column: 0 },
    { row: 3, kind: 'insert-new', column: 0 },
    { row: 2, kind: 'into-existing', column: 1 },
  ] as const)(
    'moves a row group atomically: $kind row $row column $column',
    ({ row, kind, column }) => {
      const nodes = [
        makeFrame('grid', 3),
        makeChild('a', { column: 0, row: 0 }, { x: 20, y: 64 }),
        makeChild('b', { column: 1, row: 0 }, { x: 120, y: 64 }),
        makeChild('c', { column: 2, row: 0 }, { x: 220, y: 64 }),
        makeChild('d', { column: 0, row: 1 }, { x: 20, y: 124 }),
        makeChild('e', { column: 2, row: 1 }, { x: 220, y: 124 }),
      ];
      const requests: StructuredDropRequest[] = ['a', 'b'].map(
        (nodeId, index) => ({
          nodeId,
          target: { kind: 'into-existing', slot: column + index },
          rowTarget: { kind, slot: row },
        }),
      );
      const plan = planStructuredDrop(nodes, 'frame', 'grid', 3, requests);
      const cells = cellsOf(plan);
      expect(Object.keys(cells).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(
        new Set(
          Object.values(cells).map((cell) => `${cell.column}:${cell.row}`),
        ).size,
      ).toBe(5);
      expect(cells.a.row).toBe(cells.b.row);
      expect(cells.b.column - cells.a.column).toBe(1);
      if (row === 1) {
        expect(cells.a.row).toBe(1);
        expect(cells.d.row).toBe(2);
        expect(cells.e.row).toBe(2);
      }
      const zone = describeStructuredDropZone(
        nodes,
        'frame',
        { x: 20, y: 64 },
        'grid',
        3,
        { id: 'b', x: 120, y: 64, ...SIZE },
        {
          target: requests[1].target,
          rowTarget: requests[1].rowTarget,
          requests,
        },
      );
      const committed = applyGridLayout(
        nodes.map((node) =>
          cells[node.id]
            ? {
                ...node,
                data: {
                  ...node.data,
                  frameColumn: cells[node.id].column,
                  frameRow: cells[node.id].row,
                },
              }
            : node,
        ),
        'frame',
        plan.count,
      );
      expect(zone?.placements).toHaveLength(2);
      expect(zone?.reflow.map((entry) => entry.id).sort()).toEqual([
        'c',
        'd',
        'e',
      ]);
      for (const entry of [
        ...(zone?.placements ?? []),
        ...(zone?.reflow ?? []),
      ]) {
        expect({ x: entry.x, y: entry.y }).toEqual(
          committed?.childPositions.get(entry.id),
        );
      }
    },
  );

  it('compacts a vacated whole row only after placing the complete group', () => {
    const nodes = [
      makeFrame('grid'),
      ...['a', 'b', 'c', 'd'].map((id, index) =>
        makeChild(
          id,
          { column: index % 2, row: Math.floor(index / 2) },
          { x: 20, y: 64 },
        ),
      ),
    ];
    const plan = planStructuredDrop(
      nodes,
      'frame',
      'grid',
      2,
      ['a', 'b'].map((nodeId, slot) => ({
        nodeId,
        target: { kind: 'into-existing', slot },
        rowTarget: { kind: 'insert-new', slot: 2 },
      })),
    );
    expect(cellsOf(plan)).toEqual({
      a: { column: 0, row: 1 },
      b: { column: 1, row: 1 },
      c: { column: 0, row: 0 },
      d: { column: 1, row: 0 },
    });
  });

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
      { x: 152, y: 184 },
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
