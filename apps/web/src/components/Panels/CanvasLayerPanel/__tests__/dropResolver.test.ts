// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  computeCollision,
  resolveDrop,
  type CollisionCandidate,
} from '../dropResolver';

import type { DataSourceTreeItem } from '../types';

// ── Test helpers ─────────────────────────────────────────────────

type NodeOpts = {
  parentId?: string;
  type?: string;
};

function makeItem(
  id: string,
  depth: number,
  opts: NodeOpts = {},
): DataSourceTreeItem {
  return {
    id,
    depth,
    node: {
      id,
      type: opts.type,
      parentId: opts.parentId,
      data: { label: id },
    },
  };
}

function indexById(
  items: DataSourceTreeItem[],
): Map<string, DataSourceTreeItem> {
  return new Map(items.map((i) => [i.id, i]));
}

function emptyDescendants(): Map<string, Set<string>> {
  return new Map();
}

// Row layout: each row is 20px tall, stacked from y=0.
const ROW = 20;
function candidatesFor(items: DataSourceTreeItem[]): CollisionCandidate[] {
  return items.map((item, idx) => ({
    id: item.id,
    top: idx * ROW,
    height: ROW,
  }));
}

// ── computeCollision ─────────────────────────────────────────────

describe('computeCollision — non-container row', () => {
  const items = [makeItem('a', 0), makeItem('b', 0), makeItem('c', 0)];
  const itemById = indexById(items);
  const visibleItems = items;
  const candidates = candidatesFor(items);

  it('returns null when no candidates eligible', () => {
    expect(
      computeCollision({
        pointerY: 5,
        activeId: 'a',
        candidates: [{ id: 'a', top: 0, height: ROW }],
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: new Set(),
      }),
    ).toBeNull();
  });

  it('top half of middle row → before', () => {
    // b is index 1, spans [20, 40), pointer at 25 → ratio = 0.25
    const out = computeCollision({
      pointerY: 25,
      activeId: 'x',
      candidates,
      visibleItems,
      itemById,
      descendantsByFrameId: emptyDescendants(),
      collapsedFrameIds: new Set(),
    });
    expect(out).toEqual({ id: 'b', intent: 'before' });
  });

  it('bottom half of middle row → after', () => {
    // pointer at 35 → ratio = 0.75
    const out = computeCollision({
      pointerY: 35,
      activeId: 'x',
      candidates,
      visibleItems,
      itemById,
      descendantsByFrameId: emptyDescendants(),
      collapsedFrameIds: new Set(),
    });
    expect(out).toEqual({ id: 'b', intent: 'after' });
  });

  it('PANEL-FIRST non-container row: entire row → before', () => {
    // a is index 0, spans [0, 20). Anywhere → before.
    for (const py of [1, 10, 19]) {
      const out = computeCollision({
        pointerY: py,
        activeId: 'x',
        candidates,
        visibleItems,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: new Set(),
      });
      expect(out).toEqual({ id: 'a', intent: 'before' });
    }
  });

  it('PANEL-LAST non-container row: entire row → after', () => {
    // c is index 2, spans [40, 60). Anywhere → after.
    for (const py of [41, 50, 59]) {
      const out = computeCollision({
        pointerY: py,
        activeId: 'x',
        candidates,
        visibleItems,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: new Set(),
      });
      expect(out).toEqual({ id: 'c', intent: 'after' });
    }
  });
});

describe('computeCollision — frame row zones', () => {
  // 3 rows: leaf, frame (collapsed), leaf
  const items = [
    makeItem('leaf-top', 0),
    makeItem('frame', 0, { type: 'frame' }),
    makeItem('leaf-bot', 0),
  ];
  const itemById = indexById(items);
  const candidates = candidatesFor(items);

  it('top 15% of middle frame → before', () => {
    // frame is index 1, spans [20, 40). 15% = 23 cutoff.
    const out = computeCollision({
      pointerY: 22,
      activeId: 'x',
      candidates,
      visibleItems: items,
      itemById,
      descendantsByFrameId: emptyDescendants(),
      collapsedFrameIds: new Set(['frame']),
    });
    expect(out).toEqual({ id: 'frame', intent: 'before' });
  });

  it('middle 70% of middle frame → into', () => {
    // pointer at 30 → ratio = 0.5
    const out = computeCollision({
      pointerY: 30,
      activeId: 'x',
      candidates,
      visibleItems: items,
      itemById,
      descendantsByFrameId: emptyDescendants(),
      collapsedFrameIds: new Set(['frame']),
    });
    expect(out).toEqual({ id: 'frame', intent: 'into' });
  });

  it('bottom 15% of middle COLLAPSED frame → after', () => {
    // ratio = 0.9 > 0.85
    const out = computeCollision({
      pointerY: 38,
      activeId: 'x',
      candidates,
      visibleItems: items,
      itemById,
      descendantsByFrameId: emptyDescendants(),
      collapsedFrameIds: new Set(['frame']),
    });
    expect(out).toEqual({ id: 'frame', intent: 'after' });
  });

  it('bottom 15% of middle EXPANDED frame → into (no after zone)', () => {
    // collapsedFrameIds empty → expanded → afterMin = 1.1 (unreachable)
    const out = computeCollision({
      pointerY: 38,
      activeId: 'x',
      candidates,
      visibleItems: items,
      itemById,
      descendantsByFrameId: emptyDescendants(),
      collapsedFrameIds: new Set(),
    });
    expect(out).toEqual({ id: 'frame', intent: 'into' });
  });
});

describe('computeCollision — panel-edge frame rows', () => {
  it('PANEL-FIRST collapsed frame: top 30% before, rest into, no after', () => {
    const items = [makeItem('f', 0, { type: 'frame' }), makeItem('l', 0)];
    const itemById = indexById(items);
    const candidates = candidatesFor(items);
    const collapsed = new Set(['f']);

    // top 30% (0..6) → before. ratio = 0.25
    expect(
      computeCollision({
        pointerY: 5,
        activeId: 'x',
        candidates,
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: collapsed,
      }),
    ).toEqual({ id: 'f', intent: 'before' });

    // bottom 70% → into (no after on panel-first). ratio = 0.95
    expect(
      computeCollision({
        pointerY: 19,
        activeId: 'x',
        candidates,
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: collapsed,
      }),
    ).toEqual({ id: 'f', intent: 'into' });
  });

  it('PANEL-LAST collapsed frame: top 70% into, bottom 30% after, no before', () => {
    const items = [makeItem('l', 0), makeItem('f', 0, { type: 'frame' })];
    const itemById = indexById(items);
    const candidates = candidatesFor(items);
    const collapsed = new Set(['f']);

    // ratio = 0.05 → into (no before zone). pointer y=21
    expect(
      computeCollision({
        pointerY: 21,
        activeId: 'x',
        candidates,
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: collapsed,
      }),
    ).toEqual({ id: 'f', intent: 'into' });

    // ratio = 0.8 → after. pointer y = 36
    expect(
      computeCollision({
        pointerY: 36,
        activeId: 'x',
        candidates,
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: collapsed,
      }),
    ).toEqual({ id: 'f', intent: 'after' });
  });

  it('PANEL-LAST EXPANDED frame: no after zone (collides with first child below)', () => {
    const items = [makeItem('l', 0), makeItem('f', 0, { type: 'frame' })];
    const itemById = indexById(items);
    const candidates = candidatesFor(items);

    // ratio = 0.8 → into (expanded panel-last has afterMin = 1.1)
    expect(
      computeCollision({
        pointerY: 36,
        activeId: 'x',
        candidates,
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: new Set(),
      }),
    ).toEqual({ id: 'f', intent: 'into' });
  });

  it('ONLY frame row (panel-first AND panel-last): 25/50/25 collapsed', () => {
    const items = [makeItem('f', 0, { type: 'frame' })];
    const itemById = indexById(items);
    const candidates = candidatesFor(items);
    const collapsed = new Set(['f']);

    // ratio 0.2 → before
    expect(
      computeCollision({
        pointerY: 4,
        activeId: 'x',
        candidates,
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: collapsed,
      }),
    ).toEqual({ id: 'f', intent: 'before' });
    // ratio 0.5 → into
    expect(
      computeCollision({
        pointerY: 10,
        activeId: 'x',
        candidates,
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: collapsed,
      }),
    ).toEqual({ id: 'f', intent: 'into' });
    // ratio 0.8 → after
    expect(
      computeCollision({
        pointerY: 16,
        activeId: 'x',
        candidates,
        visibleItems: items,
        itemById,
        descendantsByFrameId: emptyDescendants(),
        collapsedFrameIds: collapsed,
      }),
    ).toEqual({ id: 'f', intent: 'after' });
  });
});

describe('computeCollision — descendant cycle prevention', () => {
  // active = 'parent-frame', candidate = 'child' which is a descendant.
  // canDropInto must be false → falls back to non-container before/after split.
  it('active descendant frame: into is suppressed → before/after split', () => {
    const items = [makeItem('child', 0, { type: 'frame' })];
    const itemById = indexById(items);
    const candidates = candidatesFor(items);
    const descendants = new Map<string, Set<string>>([
      ['parent-frame', new Set(['child'])],
    ]);

    // ratio 0.5 → cannot be `into` (active has child as descendant);
    // also panel-first+last leaf with `before` cutoff = 0.5, so 0.5 → after.
    const out = computeCollision({
      pointerY: 10,
      activeId: 'parent-frame',
      candidates,
      visibleItems: items,
      itemById,
      descendantsByFrameId: descendants,
      collapsedFrameIds: new Set(),
    });
    // Single-row panel with isPanelFirst && isPanelLast and non-container
    // → cutoff = 0.5; ratio 0.5 < 0.5 is false → 'after'.
    expect(out).toEqual({ id: 'child', intent: 'after' });
  });
});

// ── resolveDrop ──────────────────────────────────────────────────

describe('resolveDrop — Rule 1: into a container', () => {
  it('into EXPANDED frame: anchor=after, depth+1, highlight=overId', () => {
    const items = [makeItem('f', 0, { type: 'frame' })];
    const itemById = indexById(items);
    const visibleItemMap = indexById(items);

    const out = resolveDrop({
      overId: 'f',
      rawIntent: 'into',
      itemById,
      visibleItemMap,
      visibleItems: items,
      collapsedFrameIds: new Set(), // expanded
    });

    expect(out).toEqual({
      anchorId: 'f',
      anchorIntent: 'after',
      anchorDepth: 1,
      effectiveOverId: 'f',
      effectiveIntent: 'into',
      intoHighlightId: 'f',
    });
  });

  it('into COLLAPSED frame: anchor=into, depth=same, highlight=overId', () => {
    const items = [makeItem('f', 0, { type: 'frame' })];
    const itemById = indexById(items);
    const visibleItemMap = indexById(items);

    const out = resolveDrop({
      overId: 'f',
      rawIntent: 'into',
      itemById,
      visibleItemMap,
      visibleItems: items,
      collapsedFrameIds: new Set(['f']),
    });

    expect(out).toEqual({
      anchorId: 'f',
      anchorIntent: 'into',
      anchorDepth: 0,
      effectiveOverId: 'f',
      effectiveIntent: 'into',
      intoHighlightId: 'f',
    });
  });

  it('into non-container: falls through to default (no Rule 1)', () => {
    const items = [makeItem('leaf', 0)];
    const itemById = indexById(items);
    const visibleItemMap = indexById(items);

    const out = resolveDrop({
      overId: 'leaf',
      rawIntent: 'into',
      itemById,
      visibleItemMap,
      visibleItems: items,
      collapsedFrameIds: new Set(),
    });

    // Default rule applied; leaf has no parent → no highlight.
    expect(out).toEqual({
      anchorId: 'leaf',
      anchorIntent: 'into',
      anchorDepth: 0,
      effectiveOverId: 'leaf',
      effectiveIntent: 'into',
    });
  });
});

describe('resolveDrop — Rule 2: escape panel-bottom leaf', () => {
  it('after a panel-bottom leaf inside a frame → drop as frame sibling', () => {
    // frame > leaf  (leaf is the only / last child of frame)
    const frame = makeItem('frame', 0, { type: 'frame' });
    const leaf = makeItem('leaf', 1, { parentId: 'frame' });
    const items = [frame, leaf];
    const itemById = indexById(items);
    const visibleItemMap = indexById(items);

    const out = resolveDrop({
      overId: 'leaf',
      rawIntent: 'after',
      itemById,
      visibleItemMap,
      visibleItems: items,
      collapsedFrameIds: new Set(),
    });

    expect(out).toEqual({
      anchorId: 'leaf',
      anchorIntent: 'after',
      anchorDepth: 0, // parent (frame) depth
      effectiveOverId: 'frame',
      effectiveIntent: 'after',
      // no grandparent → no highlight
    });
  });

  it('after panel-bottom leaf when grandparent is a frame → grandparent highlight', () => {
    const outer = makeItem('outer', 0, { type: 'frame' });
    const inner = makeItem('inner', 1, { type: 'frame', parentId: 'outer' });
    const leaf = makeItem('leaf', 2, { parentId: 'inner' });
    const items = [outer, inner, leaf];
    const itemById = indexById(items);
    const visibleItemMap = indexById(items);

    const out = resolveDrop({
      overId: 'leaf',
      rawIntent: 'after',
      itemById,
      visibleItemMap,
      visibleItems: items,
      collapsedFrameIds: new Set(),
    });

    expect(out).toEqual({
      anchorId: 'leaf',
      anchorIntent: 'after',
      anchorDepth: 1, // inner depth
      effectiveOverId: 'inner',
      effectiveIntent: 'after',
      intoHighlightId: 'outer',
    });
  });

  it('after a leaf that is NOT panel-bottom → default (no escape)', () => {
    // frame > leaf-a, leaf-b (leaf-a has a sibling after it)
    const frame = makeItem('frame', 0, { type: 'frame' });
    const a = makeItem('a', 1, { parentId: 'frame' });
    const b = makeItem('b', 1, { parentId: 'frame' });
    const items = [frame, a, b];
    const itemById = indexById(items);
    const visibleItemMap = indexById(items);

    const out = resolveDrop({
      overId: 'a',
      rawIntent: 'after',
      itemById,
      visibleItemMap,
      visibleItems: items,
      collapsedFrameIds: new Set(),
    });

    // Default rule: effective = a, highlight = parent frame
    expect(out).toEqual({
      anchorId: 'a',
      anchorIntent: 'after',
      anchorDepth: 1,
      effectiveOverId: 'a',
      effectiveIntent: 'after',
      intoHighlightId: 'frame',
    });
  });
});

describe('resolveDrop — Rule 3 (default)', () => {
  it('target inside frame: highlight = parent frame', () => {
    const frame = makeItem('frame', 0, { type: 'frame' });
    const leaf = makeItem('leaf', 1, { parentId: 'frame' });
    const items = [frame, leaf];
    const itemById = indexById(items);
    const visibleItemMap = indexById(items);

    const out = resolveDrop({
      overId: 'leaf',
      rawIntent: 'before',
      itemById,
      visibleItemMap,
      visibleItems: items,
      collapsedFrameIds: new Set(),
    });

    expect(out).toEqual({
      anchorId: 'leaf',
      anchorIntent: 'before',
      anchorDepth: 1,
      effectiveOverId: 'leaf',
      effectiveIntent: 'before',
      intoHighlightId: 'frame',
    });
  });

  it('top-level target: no highlight', () => {
    const a = makeItem('a', 0);
    const b = makeItem('b', 0);
    const items = [a, b];
    const itemById = indexById(items);
    const visibleItemMap = indexById(items);

    const out = resolveDrop({
      overId: 'a',
      rawIntent: 'before',
      itemById,
      visibleItemMap,
      visibleItems: items,
      collapsedFrameIds: new Set(),
    });

    expect(out).toEqual({
      anchorId: 'a',
      anchorIntent: 'before',
      anchorDepth: 0,
      effectiveOverId: 'a',
      effectiveIntent: 'before',
    });
  });

  it('missing overItem (stale visibleItemMap): degrade gracefully', () => {
    const itemById = new Map<string, DataSourceTreeItem>();
    const visibleItemMap = new Map<string, DataSourceTreeItem>();

    const out = resolveDrop({
      overId: 'unknown',
      rawIntent: 'after',
      itemById,
      visibleItemMap,
      visibleItems: [],
      collapsedFrameIds: new Set(),
    });

    expect(out).toEqual({
      anchorId: 'unknown',
      anchorIntent: 'after',
      anchorDepth: 0,
      effectiveOverId: 'unknown',
      effectiveIntent: 'after',
    });
  });
});
