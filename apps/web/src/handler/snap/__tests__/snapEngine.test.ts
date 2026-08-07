// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Unit tests for snapEngine — alignment & equal-spacing snap math.
 *
 * The engine is pure, so tests build minimal NestableNode fixtures and
 * exercise the public API (`buildCandidateIndex` + `computeSnap`)
 * directly. No React Flow or store dependency.
 */

import { describe, it, expect } from 'vitest';

import { buildCandidateIndex, computeSnap } from '../snapEngine';

import type { Rect, SnapOptions } from '../types';
import type { NestableNode } from '@huabu/shared/canvas-engine';

// ── Helpers ───────────────────────────────────────────────────────────

/** Minimal node with explicit size via `style` (no measured needed). */
function makeNode(
  id: string,
  pos: { x: number; y: number },
  size: { w: number; h: number },
  extra: Partial<NestableNode> = {},
): NestableNode {
  return {
    id,
    type: 'note',
    position: pos,
    data: {},
    style: { width: size.w, height: size.h },
    ...extra,
  } as NestableNode;
}

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

const T = 5; // tolerance in flow-space units
const opts: SnapOptions = { thresholdFlow: T, bypass: false };

// ── 1. Edge alignment ────────────────────────────────────────────────

describe('snapEngine — edge alignment', () => {
  it('snaps left edge to another node left edge within tolerance', () => {
    const candidate = makeNode('c', { x: 100, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 102, y: 200 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(102, 200, 50, 50), idx, opts);

    // 102 → 100 means delta -2.
    expect(result.deltaX).toBe(-2);
    expect(result.deltaY).toBe(0);
    expect(result.guides).toHaveLength(1);
    expect(result.guides[0].axis).toBe('x');
    expect(result.guides[0].value).toBe(100);
  });

  it('snaps source right edge to candidate left edge (touching scenario)', () => {
    const candidate = makeNode('c', { x: 200, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 148, y: 300 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    // source right edge = 198, candidate left edge = 200 → delta +2
    const result = computeSnap(rect(148, 300, 50, 50), idx, opts);

    expect(result.deltaX).toBe(2);
    expect(result.guides.some((g) => g.axis === 'x' && g.value === 200)).toBe(
      true,
    );
  });

  it('snaps horizontal centres', () => {
    const candidate = makeNode('c', { x: 100, y: 0 }, { w: 80, h: 80 });
    // candidate centre = 140. Place dragged so its centre is at 142.
    const dragged = makeNode('d', { x: 122, y: 300 }, { w: 40, h: 40 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(122, 300, 40, 40), idx, opts);

    // delta should bring centre from 142 → 140 (i.e. -2 on x).
    expect(result.deltaX).toBe(-2);
  });

  it('returns no snap when nothing is within tolerance', () => {
    const candidate = makeNode('c', { x: 100, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 500, y: 500 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(500, 500, 50, 50), idx, opts);

    expect(result.deltaX).toBe(0);
    expect(result.deltaY).toBe(0);
    expect(result.guides).toEqual([]);
  });

  it('snaps independently on x and y axes', () => {
    const cx = makeNode('cx', { x: 100, y: 0 }, { w: 50, h: 50 });
    const cy = makeNode('cy', { x: 0, y: 200 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 103, y: 197 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [cx, cy, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(103, 197, 50, 50), idx, opts);

    expect(result.deltaX).toBe(-3);
    expect(result.deltaY).toBe(3);
    expect(result.guides).toHaveLength(2);
  });

  it('picks the closest line when multiple candidates are within tolerance', () => {
    const a = makeNode('a', { x: 100, y: 0 }, { w: 50, h: 50 });
    const b = makeNode('b', { x: 103, y: 100 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 104, y: 400 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex([a, b, dragged], new Set(['d']), undefined);

    // Source minX = 104. Candidate lines at 100, 103, 150, 153 ...
    // Closest is 103 (delta -1).
    const result = computeSnap(rect(104, 400, 50, 50), idx, opts);

    expect(result.deltaX).toBe(-1);
  });
});

// ── 2. Bypass + thresholds ───────────────────────────────────────────

describe('snapEngine — bypass / threshold', () => {
  it('returns zero deltas when bypass is true', () => {
    const candidate = makeNode('c', { x: 100, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 101, y: 200 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(101, 200, 50, 50), idx, {
      thresholdFlow: T,
      bypass: true,
    });

    expect(result).toEqual({ deltaX: 0, deltaY: 0, guides: [] });
  });

  it('returns zero deltas when threshold is 0', () => {
    const candidate = makeNode('c', { x: 100, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 100, y: 200 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(100, 200, 50, 50), idx, {
      thresholdFlow: 0,
      bypass: false,
    });

    expect(result.deltaX).toBe(0);
    expect(result.deltaY).toBe(0);
    expect(result.guides).toEqual([]);
  });
});

// ── 3. Candidate filtering ───────────────────────────────────────────

describe('snapEngine — candidate filtering', () => {
  it('excludes the dragged nodes themselves from candidates', () => {
    const dragged = makeNode('d', { x: 100, y: 100 }, { w: 50, h: 50 });
    const other = makeNode('o', { x: 200, y: 200 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [dragged, other],
      new Set(['d']),
      undefined,
    );

    // dragged's own edges should not appear in the index.
    expect(idx.byX.every((l) => l.nodeId !== 'd')).toBe(true);
    expect(idx.byY.every((l) => l.nodeId !== 'd')).toBe(true);
    // The other node contributes 3 lines per axis.
    expect(idx.byX).toHaveLength(3);
    expect(idx.byY).toHaveLength(3);
  });

  it('restricts candidates to nodes sharing the same parentId', () => {
    const insideFrame = makeNode(
      'a',
      { x: 10, y: 10 },
      { w: 50, h: 50 },
      {
        parentId: 'frame1',
      },
    );
    const outsideFrame = makeNode('b', { x: 100, y: 100 }, { w: 50, h: 50 });
    const dragged = makeNode(
      'd',
      { x: 12, y: 12 },
      { w: 50, h: 50 },
      {
        parentId: 'frame1',
      },
    );

    const idx = buildCandidateIndex(
      [insideFrame, outsideFrame, dragged],
      new Set(['d']),
      'frame1',
    );

    // Only the sibling inside frame1 should contribute candidates.
    const allNodeIds = new Set([
      ...idx.byX.map((l) => l.nodeId),
      ...idx.byY.map((l) => l.nodeId),
    ]);
    expect(allNodeIds).toEqual(new Set(['a']));
  });

  it('excludes descendants of a dragged frame', () => {
    const frame = makeNode('f', { x: 0, y: 0 }, { w: 300, h: 300 });
    const child = makeNode(
      'c',
      { x: 50, y: 50 },
      { w: 80, h: 80 },
      {
        parentId: 'f',
      },
    );
    const other = makeNode('o', { x: 500, y: 500 }, { w: 50, h: 50 });

    const idx = buildCandidateIndex(
      [frame, child, other],
      new Set(['f']),
      undefined,
    );

    // Only the top-level 'other' node should appear.
    const ids = new Set(idx.byX.map((l) => l.nodeId));
    expect(ids).toEqual(new Set(['o']));
  });

  it('ignores candidates with zero size', () => {
    const sized = makeNode('a', { x: 100, y: 100 }, { w: 50, h: 50 });
    const zero = makeNode('z', { x: 0, y: 0 }, { w: 0, h: 0 });
    const dragged = makeNode('d', { x: 200, y: 200 }, { w: 50, h: 50 });

    const idx = buildCandidateIndex(
      [sized, zero, dragged],
      new Set(['d']),
      undefined,
    );

    expect(idx.byX.every((l) => l.nodeId !== 'z')).toBe(true);
    expect(idx.byY.every((l) => l.nodeId !== 'z')).toBe(true);
  });

  it('resolves absolute positions for deeply-nested candidates', () => {
    // Regression guard for the shared-getter refactor: the engine
    // used to call `getAbsolutePosition(nodes, n.id)` per candidate,
    // each rebuilding the id→node map (O(N²)). The new path builds a
    // single getter and walks the parent chain once. The behaviour we
    // care about — absolute candidate-line coordinates — must stay
    // exact for nested frames, otherwise snap targets drift.
    const outer = makeNode('outer', { x: 100, y: 100 }, { w: 400, h: 400 });
    const inner = makeNode(
      'inner',
      { x: 50, y: 50 },
      { w: 200, h: 200 },
      { parentId: 'outer' },
    );
    const grandchild = makeNode(
      'gc',
      { x: 20, y: 30 },
      { w: 60, h: 60 },
      { parentId: 'inner' },
    );
    // Dragged sibling of `grandchild` (so parentId === 'inner').
    const dragged = makeNode(
      'd',
      { x: 100, y: 100 },
      { w: 40, h: 40 },
      { parentId: 'inner' },
    );

    const idx = buildCandidateIndex(
      [outer, inner, grandchild, dragged],
      new Set(['d']),
      'inner',
    );

    // grandchild absolute position = 100+50+20 = 170, 100+50+30 = 180.
    // Candidate lines must reflect those absolute coordinates.
    const gcMinXLine = idx.byX.find(
      (l) => l.nodeId === 'gc' && l.edge === 'min',
    );
    const gcMinYLine = idx.byY.find(
      (l) => l.nodeId === 'gc' && l.edge === 'min',
    );
    expect(gcMinXLine?.value).toBe(170);
    expect(gcMinYLine?.value).toBe(180);
  });
});

// ── 4. Equal spacing ─────────────────────────────────────────────────

describe('snapEngine — equal spacing', () => {
  it('snaps to the midpoint between two siblings on the x axis', () => {
    // Two siblings in the same horizontal band: gap between them = 200.
    // Dragged is 50 wide → equal-spaced position has each gap = 75.
    const left = makeNode('L', { x: 0, y: 0 }, { w: 50, h: 50 });
    const right = makeNode('R', { x: 250, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 130, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [left, right, dragged],
      new Set(['d']),
      undefined,
    );

    // Expected snapped x = lMax + gap = 50 + 75 = 125. Delta = -5.
    const result = computeSnap(rect(130, 0, 50, 50), idx, opts);

    expect(result.deltaX).toBe(-5);
    // Equal-spacing guide should be emitted.
    expect(result.guides.some((g) => g.kind === 'equal-spacing')).toBe(true);
  });

  it('does not emit equal-spacing when edge alignment already snapped that axis', () => {
    // Two siblings whose midpoint would equal-space — but a third
    // sibling provides an edge-alignment candidate at the same x.
    const left = makeNode('L', { x: 0, y: 0 }, { w: 50, h: 50 });
    const right = makeNode('R', { x: 250, y: 0 }, { w: 50, h: 50 });
    const edgeMatch = makeNode('E', { x: 130, y: 400 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 131, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [left, right, edgeMatch, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(131, 0, 50, 50), idx, opts);

    // Should snap to 130 (edge alignment), not 125 (equal spacing).
    expect(result.deltaX).toBe(-1);
    expect(result.guides.every((g) => g.kind !== 'equal-spacing')).toBe(true);
  });

  it('only considers siblings that overlap the source on the perpendicular axis', () => {
    // L and R are in a different "row" from the dragged source — no
    // perpendicular overlap, so no equal-spacing match.
    const left = makeNode('L', { x: 0, y: 500 }, { w: 50, h: 50 });
    const right = makeNode('R', { x: 250, y: 500 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 130, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [left, right, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(130, 0, 50, 50), idx, opts);

    expect(result.deltaX).toBe(0);
    expect(result.deltaY).toBe(0);
    expect(result.guides).toEqual([]);
  });
});

// ── 5. Trailing equal spacing (extend an existing rhythm) ────────────

describe('snapEngine — trailing equal spacing', () => {
  it('snaps a source dragged to the right of two siblings into the same gap', () => {
    // A=[0,50], B=[100,150]. Gap A→B = 50. Drag source near x=202.
    // Expected snapped src.x = B.right(150) + 50 = 200 → delta -2.
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 100, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 202, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex([A, B, dragged], new Set(['d']), undefined);

    const result = computeSnap(rect(202, 0, 50, 50), idx, opts);

    expect(result.deltaX).toBe(-2);
    expect(result.deltaY).toBe(0);
    const eqGuide = result.guides.find((g) => g.kind === 'equal-spacing');
    expect(eqGuide).toBeDefined();
    expect(eqGuide?.kind === 'equal-spacing' ? eqGuide.rects : []).toHaveLength(
      3,
    );
  });

  it('snaps a source dragged to the left of two siblings (right-side rhythm)', () => {
    // B=[200,250], C=[300,350]. Gap B→C = 50.
    // Right-side rhythm wants src.max = B.left(200) - 50 = 150 → src.x = 100.
    // Source positioned at x=102 (delta -2, within tolerance), and far
    // enough from B's edges that no edge-alignment fires first
    // (src.max=152 vs B.min=200 = 48 apart, out of tolerance).
    const B = makeNode('B', { x: 200, y: 0 }, { w: 50, h: 50 });
    const C = makeNode('C', { x: 300, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 102, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex([B, C, dragged], new Set(['d']), undefined);

    const result = computeSnap(rect(102, 0, 50, 50), idx, opts);
    expect(result.deltaX).toBe(-2);
    expect(result.deltaY).toBe(0);
    expect(result.guides.some((g) => g.kind === 'equal-spacing')).toBe(true);
  });

  it('does not fire trailing when only one sibling exists on the source side', () => {
    // Only A on the left of source → can't form a 2-rect rhythm.
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 200, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex([A, dragged], new Set(['d']), undefined);

    const result = computeSnap(rect(200, 0, 50, 50), idx, opts);
    expect(result.deltaX).toBe(0);
    expect(result.guides.every((g) => g.kind !== 'equal-spacing')).toBe(true);
  });

  it('skips siblings without perpendicular overlap', () => {
    // A and B are in a different row (y=500) from the source (y=0).
    // The perp-overlap filter drops them, so no trailing rhythm.
    const A = makeNode('A', { x: 0, y: 500 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 100, y: 500 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 202, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex([A, B, dragged], new Set(['d']), undefined);

    const result = computeSnap(rect(202, 0, 50, 50), idx, opts);
    expect(result.deltaX).toBe(0);
    expect(result.guides).toEqual([]);
  });

  it('middle equal-spacing takes priority over trailing', () => {
    // A=[0,50], B=[100,150], C=[200,250]. Drag source near the
    // midpoint of B-C (so middle-equal between B and C fires) AND
    // close enough to the trailing position from (A, B) rhythm.
    // Middle equal should win — verify by checking the guide rects
    // include the SOURCE in the middle position (not at the end).
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 100, y: 0 }, { w: 50, h: 50 });
    const C = makeNode('C', { x: 250, y: 0 }, { w: 50, h: 50 });
    // Source between B and C, slightly off the midpoint.
    // B.right = 150, C.left = 250. With src width 50 → midpoint src.x = 175.
    const dragged = makeNode('d', { x: 177, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [A, B, C, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(177, 0, 50, 50), idx, opts);

    // Middle-equal target: x=175 → delta -2.
    expect(result.deltaX).toBe(-2);
    const eqGuide = result.guides.find((g) => g.kind === 'equal-spacing');
    expect(eqGuide).toBeDefined();
    // The middle-equal rect order is [left, source, right] → source x=175
    // sits between B (x=100) and C (x=250).
    const rects = eqGuide?.kind === 'equal-spacing' ? eqGuide.rects : [];
    expect(rects[1].x).toBe(175);
  });

  it('picks the smaller-delta hit when both left and right sides offer a rhythm', () => {
    // Layout:  A=[0,50]  B=[100,150]  source  D=[400,450]  E=[500,550]
    // Left rhythm (A→B): gap = 50 → src snaps to x = 200
    // Right rhythm (D→E): gap = 50 → src snaps to x = 400 - 50 - 50 = 300
    // Source at x=199 → left delta = +1, right delta = +101 → pick left.
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 100, y: 0 }, { w: 50, h: 50 });
    const D = makeNode('D', { x: 400, y: 0 }, { w: 50, h: 50 });
    const E = makeNode('E', { x: 500, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 199, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [A, B, D, E, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(199, 0, 50, 50), idx, opts);
    expect(result.deltaX).toBe(1); // snap to 200, the left rhythm extension
  });

  it('does not fire when near and far do not overlap each other on the perp axis', () => {
    // Regression for "false-positive trailing rhythm" — both A and B
    // each individually perp-overlap a tall source, but A sits at the
    // top and B at the bottom so they don't overlap each other. They
    // therefore do NOT form a row, and the trailing rule must not
    // infer a rhythm from them.
    //
    //                   ┌────────┐
    //   [A]             │        │     ← source: tall (y 0..300)
    //                   │        │
    //                   │        │
    //   [B]             │        │
    //                   └────────┘
    //
    // A=(x:0, y:0, w:50, h:20),  B=(x:0, y:280, w:50, h:20).
    // Without the perp-overlap check between A and B, the gap math
    // would happily snap the tall source to extend a phantom rhythm.
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 20 });
    const B = makeNode('B', { x: 0, y: 280 }, { w: 50, h: 20 });
    const dragged = makeNode('d', { x: 200, y: 0 }, { w: 40, h: 300 });
    const idx = buildCandidateIndex([A, B, dragged], new Set(['d']), undefined);

    const result = computeSnap(rect(200, 0, 40, 300), idx, opts);

    expect(result.deltaX).toBe(0);
    expect(result.guides.every((g) => g.kind !== 'equal-spacing')).toBe(true);
  });
});

// ── 6. Guide segment math ────────────────────────────────────────────

describe('snapEngine — guide segments', () => {
  it('spans both the candidate rect and the snapped source rect', () => {
    const candidate = makeNode('c', { x: 100, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 102, y: 300 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(102, 300, 50, 50), idx, opts);

    const xGuide = result.guides.find((g) => g.axis === 'x');
    expect(xGuide).toBeDefined();
    // Candidate y-range: 0..50. Source y-range: 300..350. Guide segment
    // should span 0..350.
    expect(xGuide?.from).toBe(0);
    expect(xGuide?.to).toBe(350);
  });
});

// ── 7. Active-edge filtering (resize support) ────────────────────────

describe('snapEngine — activeEdges (resize support)', () => {
  it("'min' restricts the x-axis probe to the source min edge", () => {
    // Candidate at x=100 has min=100, max=150, mid=125.
    // Source rect: x=98, w=200 → src.min=98, src.max=298, src.mid=198.
    // With activeEdges.x='min', the engine should only try src.min(98)
    // against candidate lines — closest is 100 (delta +2). It must
    // NOT pick a max-edge or mid-edge alignment even if one were
    // closer in a different layout.
    const candidate = makeNode('c', { x: 100, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 98, y: 200 }, { w: 200, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(98, 200, 200, 50), idx, {
      thresholdFlow: T,
      bypass: false,
      activeEdges: { x: 'min', y: 'none' },
      enableEqualSpacing: false,
    });

    expect(result.deltaX).toBe(2);
    expect(result.deltaY).toBe(0);
  });

  it("'max' restricts the x-axis probe to the source max edge", () => {
    // Candidate at x=300 has min=300. Source rect: x=0, w=298 →
    // src.max=298. With activeEdges.x='max' the engine snaps src.max
    // to 300 (delta +2). With activeEdges.x='min' the same layout
    // would snap src.min(0) → no candidate within tolerance → 0.
    const candidate = makeNode('c', { x: 300, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 0, y: 200 }, { w: 298, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const maxOnly = computeSnap(rect(0, 200, 298, 50), idx, {
      thresholdFlow: T,
      bypass: false,
      activeEdges: { x: 'max', y: 'none' },
      enableEqualSpacing: false,
    });
    expect(maxOnly.deltaX).toBe(2);

    const minOnly = computeSnap(rect(0, 200, 298, 50), idx, {
      thresholdFlow: T,
      bypass: false,
      activeEdges: { x: 'min', y: 'none' },
      enableEqualSpacing: false,
    });
    expect(minOnly.deltaX).toBe(0);
  });

  it("'none' on an axis suppresses snap on that axis entirely", () => {
    // Even with a perfectly-aligned candidate, activeEdges.x='none'
    // should never produce an x delta. This is how resize handles
    // exclude axes the user isn't actually moving (e.g. E/W edge
    // drags should not snap on y).
    const candidate = makeNode('c', { x: 100, y: 100 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 101, y: 101 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(101, 101, 50, 50), idx, {
      thresholdFlow: T,
      bypass: false,
      activeEdges: { x: 'none', y: 'none' },
      enableEqualSpacing: false,
    });

    expect(result.deltaX).toBe(0);
    expect(result.deltaY).toBe(0);
    expect(result.guides).toEqual([]);
  });

  it("'both' (default) reproduces the existing edge-alignment behaviour", () => {
    // Sanity check: passing the new option with both axes 'both'
    // and equal-spacing enabled must match the legacy result for
    // the same input.
    const candidate = makeNode('c', { x: 100, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 102, y: 200 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [candidate, dragged],
      new Set(['d']),
      undefined,
    );

    const legacy = computeSnap(rect(102, 200, 50, 50), idx, opts);
    const explicit = computeSnap(rect(102, 200, 50, 50), idx, {
      ...opts,
      activeEdges: { x: 'both', y: 'both' },
      enableEqualSpacing: true,
    });

    expect(explicit).toEqual(legacy);
  });
});

// ── 8. Equal-spacing toggle ──────────────────────────────────────────

describe('snapEngine — enableEqualSpacing', () => {
  it('disables equal-spacing detection when false', () => {
    // Same layout as the "midpoint between two siblings" test: with
    // equal-spacing OFF the engine must fall back to no-snap (no
    // edge-alignment candidate is within tolerance).
    const left = makeNode('L', { x: 0, y: 0 }, { w: 50, h: 50 });
    const right = makeNode('R', { x: 250, y: 0 }, { w: 50, h: 50 });
    const dragged = makeNode('d', { x: 130, y: 0 }, { w: 50, h: 50 });
    const idx = buildCandidateIndex(
      [left, right, dragged],
      new Set(['d']),
      undefined,
    );

    const result = computeSnap(rect(130, 0, 50, 50), idx, {
      thresholdFlow: T,
      bypass: false,
      enableEqualSpacing: false,
    });

    expect(result.deltaX).toBe(0);
    expect(result.guides.every((g) => g.kind !== 'equal-spacing')).toBe(true);
  });
});
