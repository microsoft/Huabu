// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Compatibility for the pre-split `data.frameSlot`.
 *
 * Structured frames used to store one track index per child under a
 * single mode-dependent name: it meant the column under `column` /
 * `grid` and the row under `row`. Each axis now owns a field named
 * after it (`frameColumn` / `frameRow`), which leaves canvases written
 * by older builds carrying the old name.
 *
 * The contract pinned here:
 *   • Reading falls back to `frameSlot` on the **count axis only**, so a
 *     pre-split child keeps the track its user chose.
 *   • `grid` never reads `frameSlot` as a row. A `frameSlot` seen there
 *     came from a `column` frame and means a column; reusing it as the
 *     row would deal every child onto the diagonal.
 *   • Relayout sheds the legacy field, so a canvas self-heals on its
 *     first structured pass and the fallback can eventually be deleted.
 */

import { describe, it, expect } from 'vitest';

import {
  applyStructuredFrameRelayout,
  applyGridLayout,
} from '../gridLayout.js';

import type { Node } from '@xyflow/react';

function legacyFrame(layoutMode: 'column' | 'row' | 'grid'): Node {
  return {
    id: 'frame',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: { layoutMode, gridCount: 2 },
    style: { width: 400, height: 300 },
    measured: { width: 400, height: 300 },
  } as Node;
}

/** A child as an older build would have persisted it. */
function legacyChild(id: string, frameSlot: number, y: number): Node {
  return {
    id,
    type: 'text',
    parentId: 'frame',
    position: { x: 0, y },
    data: { frameSlot },
    style: { width: 100, height: 40 },
    measured: { width: 100, height: 40 },
  } as Node;
}

describe('legacy frameSlot', () => {
  it('keeps a pre-split child in its column', () => {
    const nodes = [
      legacyFrame('column'),
      legacyChild('a', 1, 0),
      legacyChild('b', 0, 100),
    ];

    const { nodes: next } = applyStructuredFrameRelayout(nodes, ['frame']);
    const data = (id: string) =>
      next.find((n) => n.id === id)?.data as Record<string, unknown>;

    expect(data('a').frameColumn).toBe(1);
    expect(data('b').frameColumn).toBe(0);
  });

  it('reads it as the row for a row frame', () => {
    const nodes = [
      legacyFrame('row'),
      legacyChild('a', 1, 0),
      legacyChild('b', 0, 100),
    ];

    const { nodes: next } = applyStructuredFrameRelayout(nodes, ['frame']);
    const data = (id: string) =>
      next.find((n) => n.id === id)?.data as Record<string, unknown>;

    // A `row` frame's track IS its row, so the legacy index lands there
    // and never on `frameColumn`.
    expect(data('a').frameRow).toBe(1);
    expect(data('a').frameColumn).toBeUndefined();
    expect(data('b').frameRow).toBe(0);
  });

  it('sheds the legacy field on relayout', () => {
    const nodes = [
      legacyFrame('column'),
      legacyChild('a', 0, 0),
      legacyChild('b', 1, 0),
    ];

    const { nodes: next } = applyStructuredFrameRelayout(nodes, ['frame']);

    for (const id of ['a', 'b']) {
      const data = next.find((n) => n.id === id)?.data as Record<
        string,
        unknown
      >;
      expect('frameSlot' in data).toBe(false);
    }
  });

  it('never reuses it as a grid row', () => {
    // Both children carry `frameSlot: 1` — a column, not a row. Taking
    // it as the row too would stack them in one cell and force the
    // collision bump, splitting a pair that belongs together.
    const nodes = [
      legacyFrame('grid'),
      legacyChild('a', 1, 0),
      legacyChild('b', 1, 100),
    ];

    const solved = applyGridLayout(nodes, 'frame', 2);

    // Column 0 held nobody, so `'compact'` drops it and column 1
    // renumbers to 0 — both children still share one column.
    expect(solved?.slotAssignments.get('a')).toBe(
      solved?.slotAssignments.get('b'),
    );
    // Rows come only from `frameRow`, which neither child has, so they
    // default to row 0 and the per-column collision rule separates them.
    expect(solved?.rowAssignments?.get('a')).toBe(0);
    expect(solved?.rowAssignments?.get('b')).toBe(1);
  });
});
