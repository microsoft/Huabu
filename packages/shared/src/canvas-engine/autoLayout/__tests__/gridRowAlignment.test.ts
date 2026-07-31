/**
 * @file Tests for `applyGridLayout` — the `grid` layout mode.
 *
 * `grid` reuses the `column` mode's track model (N columns, column
 * index stored in `data.frameSlot`) but aligns the Y axis as well:
 * children that overlap vertically are grouped into a **row band** and
 * share one Y origin.
 *
 * The contract these tests pin down:
 *   • Members of a band line up exactly (that is the whole point).
 *   • A column with no member in a band leaves the cell blank instead
 *     of pulling its next item up — this is what column masonry cannot
 *     express and what makes side-by-side correspondence survive a
 *     missing counterpart.
 *   • The layout is a fixed point, so repeated passes (and the
 *     per-tick re-solve during a resize gesture) never reshuffle rows.
 */

import { describe, it, expect } from 'vitest';

import {
  applyColumnLayout,
  applyGridLayout,
  pickGridRowTarget,
} from '../gridLayout.js';

import type { Edge, Node } from '@xyflow/react';

function makeFrame(gridCount: number): Node {
  return {
    id: 'f',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode: 'grid', gridCount },
    style: { width: 999, height: 999 },
    measured: { width: 999, height: 999 },
  } as Node;
}

function makeChild(
  id: string,
  position: { x: number; y: number },
  size: { width: number; height: number },
  frameSlot: number,
  frameRow: number,
): Node {
  return {
    id,
    type: 'text',
    parentId: 'f',
    position,
    style: { width: size.width, height: size.height },
    measured: { width: size.width, height: size.height },
    data: { frameSlot, frameRow },
  } as Node;
}

const SIZE = { width: 100, height: 50 };

/**
 * Two columns. The left column has three items; the right column has a
 * counterpart for the first and the third only — the second row is a
 * "one-to-zero" pair.
 */
function makePairedNodes(): Node[] {
  return [
    makeFrame(2),
    makeChild('left-1', { x: 0, y: 0 }, SIZE, 0, 0),
    makeChild('right-1', { x: 400, y: 0 }, SIZE, 1, 0),
    makeChild('left-2', { x: 0, y: 200 }, SIZE, 0, 1),
    makeChild('left-3', { x: 0, y: 400 }, SIZE, 0, 2),
    makeChild('right-3', { x: 400, y: 400 }, { width: 100, height: 80 }, 1, 2),
  ];
}

function positionsOf(nodes: Node[]) {
  const result = applyGridLayout(nodes, 'f', 2);
  if (!result) throw new Error('applyGridLayout returned null');
  return result;
}

/** Read a laid-out position, failing loudly when the child is missing. */
function at(
  positions: Map<string, { x: number; y: number }>,
  id: string,
): { x: number; y: number } {
  const position = positions.get(id);
  if (!position) throw new Error(`no position for "${id}"`);
  return position;
}

describe('applyGridLayout', () => {
  it('gives every member of a row band the same Y origin', () => {
    const { childPositions } = positionsOf(makePairedNodes());

    expect(at(childPositions, 'left-1').y).toBe(
      at(childPositions, 'right-1').y,
    );
    expect(at(childPositions, 'left-3').y).toBe(
      at(childPositions, 'right-3').y,
    );
  });

  it('keeps a column aligned on one X origin', () => {
    const { childPositions } = positionsOf(makePairedNodes());

    const leftX = at(childPositions, 'left-1').x;
    expect(at(childPositions, 'left-2').x).toBe(leftX);
    expect(at(childPositions, 'left-3').x).toBe(leftX);

    const rightX = at(childPositions, 'right-1').x;
    expect(at(childPositions, 'right-3').x).toBe(rightX);
    expect(rightX).toBeGreaterThan(leftX);
  });

  it('leaves the cell blank when a band has no member in a column', () => {
    const { childPositions } = positionsOf(makePairedNodes());

    const bandTops = [
      at(childPositions, 'left-1').y,
      at(childPositions, 'left-2').y,
      at(childPositions, 'left-3').y,
    ];
    // Three distinct bands, in the children's original vertical order.
    expect(bandTops[0]).toBeLessThan(bandTops[1]);
    expect(bandTops[1]).toBeLessThan(bandTops[2]);

    // `right-3` stays paired with `left-3` rather than sliding up into
    // the band `left-2` occupies alone.
    expect(at(childPositions, 'right-3').y).toBe(bandTops[2]);
  });

  it('differs from column masonry, which pulls the second item up', () => {
    const nodes = makePairedNodes();
    const masonry = applyColumnLayout(nodes, 'f', 2);
    if (!masonry) throw new Error('applyColumnLayout returned null');

    // Column masonry stacks each column independently, so the right
    // column's second item lands at the same offset as the left
    // column's second item — breaking the pairing.
    expect(at(masonry.childPositions, 'right-3').y).toBe(
      at(masonry.childPositions, 'left-2').y,
    );

    const grid = positionsOf(nodes);
    expect(at(grid.childPositions, 'right-3').y).not.toBe(
      at(grid.childPositions, 'left-2').y,
    );
  });

  it('sizes the band to its tallest member', () => {
    const { childPositions, frameSize } = positionsOf(makePairedNodes());

    // The last band holds the 80px-tall `right-3`, so the frame must
    // clear that rather than the 50px `left-3`.
    const lastBandTop = at(childPositions, 'left-3').y;
    expect(frameSize.height).toBeGreaterThanOrEqual(lastBandTop + 80);
  });

  it('keeps rows stable when rendered Y positions change', () => {
    const nodes = makePairedNodes();
    const first = positionsOf(nodes);

    const relaid = nodes.map((n) => {
      if (n.id === 'right-3')
        return { ...n, position: { ...n.position, y: 0 } };
      return n;
    });
    const second = positionsOf(relaid);

    for (const [id, position] of first.childPositions) {
      expect(second.childPositions.get(id)).toEqual(position);
    }
    expect(second.frameSize).toEqual(first.frameSize);
  });

  it('bands zero-height children that share an origin', () => {
    const nodes = [
      makeFrame(2),
      makeChild('a', { x: 0, y: 0 }, { width: 100, height: 0 }, 0, 0),
      makeChild('b', { x: 400, y: 0 }, { width: 100, height: 0 }, 1, 0),
    ];
    const { childPositions } = positionsOf(nodes);

    expect(at(childPositions, 'a').y).toBe(at(childPositions, 'b').y);
  });

  it('never puts two children of the same column in one band', () => {
    // Both left-column children start at y = 0, so a naive overlap
    // sweep would merge them into a single band and stack them on top
    // of each other.
    const nodes = [
      makeFrame(2),
      makeChild('left-a', { x: 0, y: 0 }, SIZE, 0, 0),
      makeChild('left-b', { x: 0, y: 0 }, SIZE, 0, 0),
      makeChild('right-a', { x: 400, y: 0 }, SIZE, 1, 0),
    ];
    const { childPositions, rowAssignments } = positionsOf(nodes);

    expect(at(childPositions, 'left-a').y).not.toBe(
      at(childPositions, 'left-b').y,
    );
    expect(rowAssignments?.get('left-a')).not.toBe(
      rowAssignments?.get('left-b'),
    );
  });

  it('does not let the dragged node position move row hit areas', () => {
    const nodes = makePairedNodes();
    const layout = positionsOf(nodes);
    const secondRowY = at(layout.childPositions, 'left-2').y + SIZE.height / 2;

    expect(pickGridRowTarget(nodes, 'f', secondRowY)).toBe(1);

    const liveDragNodes = nodes.map((node) =>
      node.id === 'left-1'
        ? { ...node, position: { ...node.position, y: 10_000 } }
        : node,
    );
    expect(pickGridRowTarget(liveDragNodes, 'f', secondRowY)).toBe(1);
  });

  it('uses edge-aware gutter geometry for row hit areas', () => {
    const nodes = makePairedNodes();
    const edges: Edge[] = [
      {
        id: 'edge-labelled',
        source: 'left-1',
        target: 'left-2',
        data: { label: 'A wide label between persistent rows' },
      },
    ];
    const layout = applyGridLayout(nodes, 'f', 2, 'compact', { edges });
    if (!layout) throw new Error('applyGridLayout returned null');
    const secondRowY = at(layout.childPositions, 'left-2').y + SIZE.height / 2;

    expect(pickGridRowTarget(nodes, 'f', secondRowY, edges)).toBe(1);
  });

  it('preserves empty row indices instead of compacting later rows', () => {
    const nodes = [
      makeFrame(2),
      makeChild('first', { x: 0, y: 0 }, SIZE, 0, 0),
      makeChild('third', { x: 0, y: 0 }, SIZE, 0, 2),
    ];
    const result = positionsOf(nodes);

    expect(result.rowAssignments).toEqual(
      new Map([
        ['first', 0],
        ['third', 2],
      ]),
    );
    expect(result.rowTracks).toHaveLength(3);
    expect(result.rowTracks?.[1].height).toBe(SIZE.height);
  });
});
