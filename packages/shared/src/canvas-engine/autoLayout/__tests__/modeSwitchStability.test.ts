// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for layout-mode switching stability.
 *
 * Switching a Frame's layout mode must not rearrange it. The user
 * already said what they wanted by placing things where they are; a
 * mode switch changes which rules maintain that arrangement, not the
 * arrangement itself.
 *
 * The track count is the crux. It used to be inherited across a switch
 * (or defaulted to 1 when absent), so every transition re-flowed the
 * children against a number chosen for a different axis — a hand-made
 * 3x2 grid collapsed into a single column no matter which mode you
 * picked. A mode change now drops the stored count and the children's
 * stored cells, and the solver re-derives both from the geometry that
 * is on screen.
 *
 * Naming a count explicitly is the opposite instruction: "re-flow into
 * this many tracks". Those cases are pinned down at the bottom.
 */

import { describe, it, expect } from 'vitest';

import { executeCanvasCommands } from '../../executor.js';
import { applyGridLayout } from '../gridLayout.js';

import type { CanvasCommand, FrameLayoutMode } from '../../../index.js';
import type { Node } from '@xyflow/react';

const SIZE = { width: 100, height: 50 };

function makeFrame(layoutMode: FrameLayoutMode): Node {
  return {
    id: 'f',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode, sizing: 'hug' },
    style: { width: 900, height: 900 },
    measured: { width: 900, height: 900 },
  } as Node;
}

function child(id: string, x: number, y: number): Node {
  return {
    id,
    type: 'text',
    parentId: 'f',
    position: { x, y },
    style: SIZE,
    measured: SIZE,
    data: {},
  } as Node;
}

/**
 * A tidy 3-column x 2-row arrangement, made by hand in `free` mode.
 * Every column and every row is unambiguous, so any regrouping after a
 * mode switch is a real regression rather than a judgement call.
 */
function tidyGrid(): Node[] {
  return [
    makeFrame('free'),
    child('A', 0, 0),
    child('B', 200, 0),
    child('C', 400, 0),
    child('D', 0, 100),
    child('E', 200, 100),
    child('F', 400, 100),
  ];
}

function setMode(
  nodes: Node[],
  mode: FrameLayoutMode,
  gridCount?: number,
  gridRowCount?: number,
): Node[] {
  const command = {
    type: 'SET_FRAME_LAYOUT',
    frameId: 'f',
    mode,
    ...(gridCount === undefined ? {} : { gridCount }),
    ...(gridRowCount === undefined ? {} : { gridRowCount }),
  } as unknown as CanvasCommand;
  return executeCanvasCommands(
    { source: 'ui', commands: [command] },
    { nodes, edges: [], canvasId: 'c1' },
  ).writeResult.nodes as Node[];
}

/**
 * Group child ids by their laid-out coordinate on one axis, in
 * coordinate order — e.g. `'AD | BE | CF'` for three columns. This is
 * the arrangement as the user sees it, independent of which cell
 * fields happen to encode it.
 */
function groupsAlong(nodes: Node[], axis: 'x' | 'y'): string {
  const buckets = new Map<number, string[]>();
  for (const node of nodes) {
    if (node.parentId !== 'f') continue;
    const key = Math.round(axis === 'x' ? node.position.x : node.position.y);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(node.id);
    else buckets.set(key, [node.id]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ids]) => ids.slice().sort().join(''))
    .join(' | ');
}

function columnsOf(nodes: Node[]): string {
  return groupsAlong(nodes, 'x');
}

function rowsOf(nodes: Node[]): string {
  return groupsAlong(nodes, 'y');
}

function gridCountOf(nodes: Node[]): number | undefined {
  const frame = nodes.find((node) => node.id === 'f');
  return (frame?.data as { gridCount?: number } | undefined)?.gridCount;
}

const TIDY_COLUMNS = 'AD | BE | CF';
const TIDY_ROWS = 'ABC | DEF';

const STRUCTURED_MODES = ['column', 'row', 'grid'] as const;

describe('mode switch preserves the arrangement', () => {
  it('starts from an unambiguous 3x2', () => {
    const nodes = tidyGrid();
    expect(columnsOf(nodes)).toBe(TIDY_COLUMNS);
    expect(rowsOf(nodes)).toBe(TIDY_ROWS);
  });

  for (const mode of STRUCTURED_MODES) {
    it(`free -> ${mode} keeps every column and row intact`, () => {
      const nodes = setMode(tidyGrid(), mode);
      expect(columnsOf(nodes)).toBe(TIDY_COLUMNS);
      expect(rowsOf(nodes)).toBe(TIDY_ROWS);
    });
  }

  for (const from of STRUCTURED_MODES) {
    for (const to of STRUCTURED_MODES) {
      if (from === to) continue;
      it(`${from} -> ${to} keeps every column and row intact`, () => {
        const once = setMode(tidyGrid(), from);
        const twice = setMode(once, to);
        expect(columnsOf(twice)).toBe(TIDY_COLUMNS);
        expect(rowsOf(twice)).toBe(TIDY_ROWS);
      });
    }

    it(`${from} -> free leaves the children where they are`, () => {
      const structured = setMode(tidyGrid(), from);
      const freed = setMode(structured, 'free');
      expect(columnsOf(freed)).toBe(columnsOf(structured));
      expect(rowsOf(freed)).toBe(rowsOf(structured));
    });
  }

  it('round-trips through every mode without drift', () => {
    let nodes = tidyGrid();
    for (const mode of ['column', 'grid', 'row', 'column', 'grid'] as const) {
      nodes = setMode(nodes, mode);
      expect(columnsOf(nodes)).toBe(TIDY_COLUMNS);
      expect(rowsOf(nodes)).toBe(TIDY_ROWS);
    }
  });
});

describe('mode switch resolves the track count from geometry', () => {
  it('counts columns for `column`', () => {
    expect(gridCountOf(setMode(tidyGrid(), 'column'))).toBe(3);
  });

  it('counts rows for `row`', () => {
    expect(gridCountOf(setMode(tidyGrid(), 'row'))).toBe(2);
  });

  it('counts columns for `grid`', () => {
    expect(gridCountOf(setMode(tidyGrid(), 'grid'))).toBe(3);
  });

  it('re-derives the count on every switch instead of inheriting it', () => {
    // `column` resolves 3 (columns); `row` must not reuse that number,
    // it has to see 2 (rows).
    const asColumn = setMode(tidyGrid(), 'column');
    expect(gridCountOf(asColumn)).toBe(3);
    expect(gridCountOf(setMode(asColumn, 'row'))).toBe(2);
  });

  it('handles an arrangement whose axes disagree in count', () => {
    // Four visual columns, two visual rows.
    const nodes = [
      makeFrame('free'),
      child('a', 0, 0),
      child('b', 200, 0),
      child('c', 400, 0),
      child('d', 600, 0),
      child('e', 0, 100),
      child('f2', 200, 100),
    ];
    expect(gridCountOf(setMode(nodes, 'column'))).toBe(4);
    expect(gridCountOf(setMode(nodes, 'row'))).toBe(2);
  });
});

describe('an explicit count is a re-flow instruction', () => {
  it('spreads a single column into the requested number of columns', () => {
    // One visual column of four.
    const stacked = [
      makeFrame('free'),
      child('a', 0, 0),
      child('b', 0, 100),
      child('c', 0, 200),
      child('d', 0, 300),
    ];
    const asColumn = setMode(stacked, 'column');
    expect(columnsOf(asColumn)).toBe('abcd');
    expect(gridCountOf(asColumn)).toBe(1);

    const spread = setMode(asColumn, 'column', 2);
    expect(gridCountOf(spread)).toBe(2);
    expect(columnsOf(spread).split(' | ')).toHaveLength(2);
  });

  it('re-flows grid rows too, so they cannot fight the new columns', () => {
    // A tidy 3x2 grid squeezed into 2 columns. Keeping the persisted
    // rows would collide children and bump them down into a ragged
    // 2x4; re-seeding the rows keeps the result a real grid.
    const asGrid = setMode(tidyGrid(), 'grid');
    expect(gridCountOf(asGrid)).toBe(3);

    const narrowed = setMode(asGrid, 'grid', 2);
    expect(gridCountOf(narrowed)).toBe(2);
    const rows = rowsOf(narrowed).split(' | ');
    const columns = columnsOf(narrowed).split(' | ');
    expect(columns).toHaveLength(2);
    // Six children in two columns is three rows — not the four that a
    // stale row assignment used to produce.
    expect(rows).toHaveLength(3);
  });

  it('leaves the arrangement alone when only `sizing` changes', () => {
    const asGrid = setMode(tidyGrid(), 'grid');
    const resized = executeCanvasCommands(
      {
        source: 'ui',
        commands: [
          {
            type: 'SET_FRAME_LAYOUT',
            frameId: 'f',
            mode: 'grid',
            sizing: 'manual',
          } as unknown as CanvasCommand,
        ],
      },
      { nodes: asGrid, edges: [], canvasId: 'c1' },
    ).writeResult.nodes as Node[];

    expect(columnsOf(resized)).toBe(TIDY_COLUMNS);
    expect(rowsOf(resized)).toBe(TIDY_ROWS);
    expect(gridCountOf(resized)).toBe(3);
  });
});

/**
 * The two axes cannot be pinned symmetrically. Six children in three
 * columns need two rows, and asking for one cannot make them fit — so
 * the row input is a floor, not an exact count. It adds blank rows
 * (which are meaningful in `grid`, and are valid drop targets) and
 * never removes the rows the content requires.
 */
describe('grid row count is a floor', () => {
  /** Row bands the layout actually resolved to. */
  function rowBandsOf(nodes: Node[]): number {
    let maxRow = -1;
    for (const node of nodes) {
      if (node.parentId !== 'f') continue;
      const row = (node.data as { frameRow?: number } | undefined)?.frameRow;
      if (typeof row === 'number' && row > maxRow) maxRow = row;
    }
    return maxRow + 1;
  }

  function rowFloorOf(nodes: Node[]): number | undefined {
    const frame = nodes.find((node) => node.id === 'f');
    return (frame?.data as { gridRowCount?: number } | undefined)?.gridRowCount;
  }

  /** Row bands the solver actually laid out, blank ones included. */
  function rowTracksOf(nodes: Node[]): number {
    const result = applyGridLayout(nodes, 'f', undefined);
    return result?.rowTracks?.length ?? 0;
  }

  function frameHeightOf(nodes: Node[]): number {
    const frame = nodes.find((node) => node.id === 'f');
    return (frame?.style as { height?: number } | undefined)?.height ?? 0;
  }

  it('adds blank rows when asked for more than the content needs', () => {
    const asGrid = setMode(tidyGrid(), 'grid');
    expect(rowBandsOf(asGrid)).toBe(2);

    const padded = setMode(asGrid, 'grid', undefined, 4);
    expect(rowFloorOf(padded)).toBe(4);
    // The children keep their rows; the extra bands are simply empty,
    // so the arrangement is untouched.
    expect(columnsOf(padded)).toBe(TIDY_COLUMNS);
    expect(rowsOf(padded)).toBe(TIDY_ROWS);
  });

  it('honours the full range on a frame with a single child', () => {
    // The safety ceiling for untrusted `cells[].row` scales with the
    // child count (2 here), so reusing it for the row floor silently
    // cut a requested 12 down to 3 — while the toolbar went on showing
    // the persisted 12. Assert the resolved geometry, not the field.
    const single = [makeFrame('free'), child('only', 0, 0)];
    const asGrid = setMode(single, 'grid');
    const shortHeight = frameHeightOf(asGrid);

    const padded = setMode(asGrid, 'grid', undefined, 12);
    expect(rowFloorOf(padded)).toBe(12);
    expect(rowTracksOf(padded)).toBe(12);
    expect(frameHeightOf(padded)).toBeGreaterThan(shortHeight);
  });

  it('grows the frame to make room for the blank rows', () => {
    const asGrid = setMode(tidyGrid(), 'grid');
    const before = (
      asGrid.find((n) => n.id === 'f')?.style as { height?: number }
    ).height;

    const padded = setMode(asGrid, 'grid', undefined, 5);
    const after = (
      padded.find((n) => n.id === 'f')?.style as { height?: number }
    ).height;

    expect(after).toBeGreaterThan(before ?? 0);
  });

  it('cannot squeeze the content below the rows it needs', () => {
    const asGrid = setMode(tidyGrid(), 'grid');
    // Six children in three columns are two rows. Asking for one row
    // is honoured as far as it can be — which is not at all.
    const squeezed = setMode(asGrid, 'grid', undefined, 1);
    expect(rowBandsOf(squeezed)).toBe(2);
    expect(rowsOf(squeezed)).toBe(TIDY_ROWS);
  });

  it('is dropped on a layout-mode change, like the column count', () => {
    const padded = setMode(setMode(tidyGrid(), 'grid'), 'grid', undefined, 5);
    expect(rowFloorOf(padded)).toBe(5);

    // Leaving `grid` retires the floor: a row count chosen for one
    // layout says nothing about another.
    const asColumn = setMode(padded, 'column');
    expect(rowFloorOf(asColumn)).toBeUndefined();

    const backToGrid = setMode(asColumn, 'grid');
    expect(rowFloorOf(backToGrid)).toBeUndefined();
    expect(rowsOf(backToGrid)).toBe(TIDY_ROWS);
  });

  it('survives an explicit column re-flow', () => {
    // Re-flowing columns replans every cell; the floor is a frame-level
    // policy and outlives it.
    const padded = setMode(setMode(tidyGrid(), 'grid'), 'grid', undefined, 4);
    const narrowed = setMode(padded, 'grid', 2);
    expect(rowFloorOf(narrowed)).toBe(4);
    expect(gridCountOf(narrowed)).toBe(2);
  });
});
