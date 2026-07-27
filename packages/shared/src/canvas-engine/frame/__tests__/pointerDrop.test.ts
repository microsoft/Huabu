/**
 * @file Tests for pointer-aware enter / exit rules used by drag-and-drop
 * resolution and the live drag preview. Locks the additional pointer
 * options on `wouldAutoFrame` and `wouldUnframe` so:
 *   1. Dropping a node by hovering the cursor inside a frame works even
 *      when the bbox-overlap ratio is below the 0.5 area-ratio threshold.
 *   2. Repositioning a node inside its parent frame keeps the node
 *      parented while the cursor stays inside the frame's capture halo,
 *      even when the node body momentarily extends past the frame edge.
 *   3. Behaviour without the pointer option is unchanged (back-compat).
 */

import { describe, it, expect } from 'vitest';

import { wouldAutoFrame, wouldUnframe } from '../detection.js';

import type { NestableNode } from '../../container/tree.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeFrame(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  overrides: Partial<NestableNode> = {},
): NestableNode {
  return {
    id,
    type: 'frame',
    position: { x, y },
    data: {},
    style: { width: w, height: h },
    ...overrides,
  } as NestableNode;
}

function makeNode(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  overrides: Partial<NestableNode> = {},
): NestableNode {
  return {
    id,
    type: 'note',
    position: { x, y },
    data: {},
    style: { width: w, height: h },
    ...overrides,
  } as NestableNode;
}

// ── wouldAutoFrame: pointer-inside lowers the bar to "any overlap" ──────

describe('wouldAutoFrame — pointer-aware entry', () => {
  it('enters the frame when pointer is inside even though area-ratio is below threshold', () => {
    // Frame at (0,0) sized 200×200. Node mostly outside the frame: just
    // a 20×20 corner pokes in → ratio = 400 / min(10000, 40000) = 0.04
    // — far below the 0.5 threshold.
    const frame = makeFrame('f', 0, 0, 200, 200);
    const node = makeNode('n', 180, 180, 100, 100);

    // Without pointer: original rule rejects (overlap 4%).
    expect(wouldAutoFrame([frame, node], 'n', { threshold: 0.5 })).toBeNull();

    // With pointer inside the frame: qualifies (positive overlap is enough).
    expect(
      wouldAutoFrame([frame, node], 'n', {
        threshold: 0.5,
        pointer: { x: 100, y: 100 },
      }),
    ).toBe('f');
  });

  it('does not enter when pointer is inside the frame but the node has zero overlap', () => {
    // Frame 200×200 at origin, node fully outside (x=400). Cursor in
    // frame doesn't matter — without any body contact we still reject,
    // otherwise dragging a far-away node past an open frame would warp
    // it in.
    const frame = makeFrame('f', 0, 0, 200, 200);
    const node = makeNode('n', 400, 400, 100, 100);

    expect(
      wouldAutoFrame([frame, node], 'n', {
        threshold: 0.5,
        pointer: { x: 50, y: 50 },
      }),
    ).toBeNull();
  });

  it('falls back to the area-ratio threshold when pointer is outside the candidate', () => {
    // Pointer outside the frame: the original 50% rule applies.
    const frame = makeFrame('f', 0, 0, 200, 200);
    // 60% overlap → qualifies under threshold even without pointer.
    const node = makeNode('n', 80, 80, 100, 100);

    expect(
      wouldAutoFrame([frame, node], 'n', {
        threshold: 0.5,
        pointer: { x: 500, y: 500 },
      }),
    ).toBe('f');
  });

  it('matches the legacy behaviour when no pointer is provided', () => {
    const frame = makeFrame('f', 0, 0, 200, 200);
    // Only 4% overlap — must be rejected like before.
    const node = makeNode('n', 180, 180, 100, 100);

    expect(wouldAutoFrame([frame, node], 'n', { threshold: 0.5 })).toBeNull();
  });

  it('prefers the deepest frame that contains the pointer', () => {
    // Outer frame contains an inner frame; pointer falls inside inner.
    const outer = makeFrame('outer', 0, 0, 400, 400);
    const inner = makeFrame('inner', 50, 50, 200, 200, { parentId: 'outer' });
    // Node has a small overlap with both frames (positioned at inner edge).
    const node = makeNode('n', 230, 230, 100, 100);

    expect(
      wouldAutoFrame([outer, inner, node], 'n', {
        threshold: 0.5,
        pointer: { x: 100, y: 100 }, // inside inner (and outer)
      }),
    ).toBe('inner');
  });
});

// ── wouldUnframe: pointer-inside-halo keeps the node parented ───────────

describe('wouldUnframe — pointer capture halo', () => {
  it('keeps a child parented while the pointer is inside the parent frame', () => {
    const frame = makeFrame('f', 0, 0, 200, 200);
    // Child has been dragged so its bbox is fully outside the frame
    // (e.g. centre of dragged node moved past the right edge).
    const child = makeNode('c', 220, 50, 100, 100, { parentId: 'f' });

    // Without pointer info: legacy rule says unframe (zero overlap,
    // gap of 20 > margin 10).
    expect(wouldUnframe([frame, child], 'c', { epsilon: 0, margin: 10 })).toBe(
      true,
    );

    // With pointer still inside the frame: stay parented.
    expect(
      wouldUnframe([frame, child], 'c', {
        epsilon: 0,
        margin: 10,
        pointer: { x: 150, y: 100 },
        pointerCaptureMargin: 24,
      }),
    ).toBe(false);
  });

  it('keeps the child parented while the pointer is inside the capture halo just outside the frame', () => {
    const frame = makeFrame('f', 0, 0, 200, 200);
    const child = makeNode('c', 240, 50, 100, 100, { parentId: 'f' });

    // Pointer 10 px past the right edge — inside the 24 px halo.
    expect(
      wouldUnframe([frame, child], 'c', {
        epsilon: 0,
        margin: 10,
        pointer: { x: 210, y: 100 },
        pointerCaptureMargin: 24,
      }),
    ).toBe(false);
  });

  it('unframes once the pointer leaves the capture halo', () => {
    const frame = makeFrame('f', 0, 0, 200, 200);
    const child = makeNode('c', 260, 50, 100, 100, { parentId: 'f' });

    // Pointer 40 px past the right edge — outside the 24 px halo, and
    // body fully outside the frame → unframe.
    expect(
      wouldUnframe([frame, child], 'c', {
        epsilon: 0,
        margin: 10,
        pointer: { x: 240, y: 100 },
        pointerCaptureMargin: 24,
      }),
    ).toBe(true);
  });

  it('matches the legacy behaviour when no pointer is provided', () => {
    const frame = makeFrame('f', 0, 0, 200, 200);
    const child = makeNode('c', 220, 50, 100, 100, { parentId: 'f' });

    expect(wouldUnframe([frame, child], 'c', { epsilon: 0, margin: 10 })).toBe(
      true,
    );
  });

  it('honours a per-axis pointerCaptureMargin (asymmetric halo)', () => {
    // Frame 200x200; child dragged so body is past the right edge.
    // Halo: 80 px on x (wide-and-short node), 20 px on y.
    const frame = makeFrame('f', 0, 0, 200, 200);
    const child = makeNode('c', 240, 50, 100, 100, { parentId: 'f' });

    // Pointer 60 px past right edge — inside x-halo (80), keep parented.
    expect(
      wouldUnframe([frame, child], 'c', {
        epsilon: 0,
        margin: 10,
        pointer: { x: 260, y: 100 },
        pointerCaptureMargin: { x: 80, y: 20 },
      }),
    ).toBe(false);

    // Pointer 30 px past bottom edge — outside y-halo (20), unframe.
    expect(
      wouldUnframe([frame, child], 'c', {
        epsilon: 0,
        margin: 10,
        pointer: { x: 100, y: 230 },
        pointerCaptureMargin: { x: 80, y: 20 },
      }),
    ).toBe(true);
  });
});
