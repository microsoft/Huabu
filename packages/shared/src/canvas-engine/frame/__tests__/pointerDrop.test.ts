// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
 *   4. A structured frame's much larger capture zone keeps a node
 *      parented while the user aims at the append / prepend band.
 */

import { describe, it, expect } from 'vitest';

import {
  wouldAutoFrame,
  wouldUnframe,
  wouldStickToStructuredFrame,
} from '../detection.js';

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

  it('uses the pointer surface instead of overlap ratio when pointer is available', () => {
    const frame = makeFrame('f', 0, 0, 200, 200);
    // 60% overlap qualifies only for pointer-less callers. A pointer outside
    // the frame expresses a different landing surface.
    const node = makeNode('n', 80, 80, 100, 100);

    expect(
      wouldAutoFrame([frame, node], 'n', {
        threshold: 0.5,
        pointer: { x: 500, y: 500 },
      }),
    ).toBeNull();
    expect(wouldAutoFrame([frame, node], 'n', { threshold: 0.5 })).toBe('f');
  });

  it('matches the legacy behaviour when no pointer is provided', () => {
    const frame = makeFrame('f', 0, 0, 200, 200);
    // Only 4% overlap — must be rejected like before.
    const node = makeNode('n', 180, 180, 100, 100);

    expect(wouldAutoFrame([frame, node], 'n', { threshold: 0.5 })).toBeNull();
  });

  it('treats a nested frame as a frozen child unless entry is explicit', () => {
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
    ).toBe('outer');

    expect(
      wouldAutoFrame([outer, inner, node], 'n', {
        threshold: 0.5,
        pointer: { x: 100, y: 100 },
        allowNestedFrameEntry: true,
      }),
    ).toBe('inner');
  });

  it('uses the current parent as a no-op surface and exposed ancestors as upward targets', () => {
    const outer = makeFrame('outer', 0, 0, 500, 500);
    const inner = makeFrame('inner', 50, 50, 200, 200, {
      parentId: 'outer',
    });
    const node = makeNode('n', 20, 20, 100, 100, { parentId: 'inner' });

    expect(
      wouldAutoFrame([outer, inner, node], 'n', {
        threshold: 0.5,
        pointer: { x: 100, y: 100 },
      }),
    ).toBeNull();

    const movedOntoOuterSurface = {
      ...node,
      position: { x: -40, y: -40 },
    };
    expect(
      wouldAutoFrame([outer, inner, movedOntoOuterSurface], 'n', {
        threshold: 0.5,
        pointer: { x: 30, y: 30 },
      }),
    ).toBe('outer');
  });

  it('walks upward through the deepest ancestor surface under the pointer', () => {
    const outer = makeFrame('outer', 0, 0, 600, 600);
    const middle = makeFrame('middle', 100, 100, 400, 400, {
      parentId: 'outer',
    });
    const inner = makeFrame('inner', 100, 100, 200, 200, {
      parentId: 'middle',
    });
    const node = makeNode('n', 20, 20, 100, 100, { parentId: 'inner' });

    expect(
      wouldAutoFrame([outer, middle, inner, node], 'n', {
        pointer: { x: 250, y: 250 },
      }),
    ).toBeNull();

    const onMiddle = { ...node, position: { x: -70, y: -70 } };
    expect(
      wouldAutoFrame([outer, middle, inner, onMiddle], 'n', {
        pointer: { x: 150, y: 150 },
      }),
    ).toBe('middle');

    const onOuter = { ...node, position: { x: -170, y: -170 } };
    expect(
      wouldAutoFrame([outer, middle, inner, onOuter], 'n', {
        pointer: { x: 50, y: 50 },
      }),
    ).toBe('outer');

    const onCanvas = { ...node, position: { x: 450, y: 450 } };
    expect(
      wouldAutoFrame([outer, middle, inner, onCanvas], 'n', {
        pointer: { x: 700, y: 700 },
      }),
    ).toBeNull();
  });

  it('uses the pointed frame surface for explicit structured entry', () => {
    const outer = makeFrame('outer', 0, 0, 500, 500, {
      data: { layoutMode: 'grid', gridCount: 2 },
    });
    const middle = makeFrame('middle', 50, 50, 300, 300, {
      parentId: 'outer',
    });
    const inner = makeFrame('inner', 100, 100, 80, 80, {
      parentId: 'middle',
    });
    const node = makeNode('n', 140, 140, 200, 200, {
      parentId: 'outer',
    });

    expect(
      wouldAutoFrame([outer, middle, inner, node], 'n', {
        threshold: 0.5,
        pointer: { x: 80, y: 80 },
        allowNestedFrameEntry: true,
      }),
    ).toBe('middle');

    expect(
      wouldAutoFrame([outer, middle, inner, node], 'n', {
        threshold: 0.5,
        pointer: { x: 160, y: 160 },
        allowNestedFrameEntry: true,
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

// ── wouldStickToStructuredFrame: the append / prepend band ─────────────

describe('wouldStickToStructuredFrame', () => {
  const structuredFrame = () =>
    makeFrame('f', 0, 0, 200, 200, {
      data: { layoutMode: 'column', gridCount: 1 },
    });

  it('sticks in the band where a new track is opened, which the plain halo would unframe', () => {
    const frame = structuredFrame();
    // Dragged 60 px past the right edge — where the "insert a new
    // column" indicator lives. Body fully outside, and the pointer is
    // past the scaled halo (0.3 x 100 = 30 px) the free-frame rule uses.
    const child = makeNode('c', 260, 50, 100, 100, { parentId: 'f' });
    const pointer = { x: 260, y: 100 };

    expect(
      wouldUnframe([frame, child], 'c', {
        epsilon: 0,
        margin: 10,
        pointer,
        pointerCaptureMargin: { x: 30, y: 30 },
      }),
    ).toBe(true);

    // The structured zone is the frame rect grown by the node's own
    // size, so the same release keeps the node in the frame.
    expect(wouldStickToStructuredFrame([frame, child], 'c', pointer)).toBe(
      true,
    );
  });

  it('lets go once the pointer is more than a node-size away', () => {
    const frame = structuredFrame();
    const child = makeNode('c', 400, 50, 100, 100, { parentId: 'f' });

    expect(
      wouldStickToStructuredFrame([frame, child], 'c', { x: 320, y: 100 }),
    ).toBe(false);
  });

  it('does not apply to free frames or to root-level nodes', () => {
    const freeFrame = makeFrame('f', 0, 0, 200, 200, {
      data: { layoutMode: 'free' },
    });
    const child = makeNode('c', 260, 50, 100, 100, { parentId: 'f' });
    expect(
      wouldStickToStructuredFrame([freeFrame, child], 'c', { x: 260, y: 100 }),
    ).toBe(false);

    const orphan = makeNode('o', 260, 50, 100, 100);
    expect(
      wouldStickToStructuredFrame([structuredFrame(), orphan], 'o', {
        x: 210,
        y: 100,
      }),
    ).toBe(false);
  });

  it('needs a pointer — a keyboard / programmatic move never sticks', () => {
    const frame = structuredFrame();
    const child = makeNode('c', 260, 50, 100, 100, { parentId: 'f' });

    expect(wouldStickToStructuredFrame([frame, child], 'c', undefined)).toBe(
      false,
    );
  });
});
