// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Unit tests for `snapSession` — the gesture-scoped wrapper
 * around `snapEngine` that owns drag-time state for the canvas.
 *
 * These tests exercise the lifecycle (`begin` → `apply` → `end`)
 * directly against the real implementation. Side effects on
 * `gesturePreviewStore` are observed by reading its state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import {
  applySnap,
  beginSnapSession,
  consumeLastDragDecisions,
  consumeLastNestedFrameEntryAllowed,
  endSnapSession,
  isNestedFrameEntryAllowed,
  isSnapSessionActive,
  isSnapSessionDragEndCommit,
  isSnapSessionResizeEndCommit,
  applyResizeProposal,
  getResizeSnappedRect,
  getResizeContext,
  writeDragDecision,
} from '../snapSession';

import type { NestableNode } from '@huabu/shared/canvas-engine';
import type {
  NodeChange,
  NodeDimensionChange,
  NodePositionChange,
} from '@xyflow/react';

// ── Helpers ───────────────────────────────────────────────────────────

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

function posChange(
  id: string,
  position: { x: number; y: number },
  dragging: boolean,
): NodePositionChange {
  return { type: 'position', id, position, dragging };
}

// jsdom isn't configured for this test file by default, but
// `beginSnapSession` only touches `window` when it exists — the
// listener block is wrapped in `typeof window !== 'undefined'`.
// Vitest's default `happy-dom`/`jsdom` environments both expose
// `window`, so the AbortController path runs and we get to assert
// on its cleanup behaviour too.

afterEach(() => {
  // Defensive: every test ends with a clean slate so a failing
  // assertion can't leak state into the next test.
  endSnapSession();
});

describe('snapSession — lifecycle', () => {
  it('is inactive before any begin', () => {
    expect(isSnapSessionActive()).toBe(false);
  });

  it('becomes active after begin with single-parent dragged set', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 200, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
    });
    expect(isSnapSessionActive()).toBe(true);
  });

  it('end is idempotent and leaves the session inactive', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A],
      gestureIds: new Set(['A']),
      altPressed: false,
    });
    endSnapSession();
    endSnapSession();
    endSnapSession();
    expect(isSnapSessionActive()).toBe(false);
  });

  it('begin defensively ends a prior session before starting the new one', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 200, y: 0 }, { w: 50, h: 50 });

    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
    });
    // Push some guide state so we can observe the cleanup.
    useGesturePreviewStore
      .getState()
      .setSnapGuides([
        { kind: 'alignment', axis: 'x', value: 10, from: 0, to: 100 },
      ]);
    expect(useGesturePreviewStore.getState().snapGuides).toHaveLength(1);

    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
    });
    // The defensive endSnapSession inside begin must have cleared
    // the previous gesture's guides.
    expect(useGesturePreviewStore.getState().snapGuides).toEqual([]);
  });

  it('clears the gesturePreviewStore guides on end', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A],
      gestureIds: new Set(['A']),
      altPressed: false,
    });
    useGesturePreviewStore
      .getState()
      .setSnapGuides([
        { kind: 'alignment', axis: 'x', value: 10, from: 0, to: 100 },
      ]);
    endSnapSession();
    expect(useGesturePreviewStore.getState().snapGuides).toEqual([]);
  });

  it('does not intercept Space from editable targets during a session', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A],
      gestureIds: new Set(['A']),
      altPressed: false,
    });
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    const keydown = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(keydown);

    expect(keydown.defaultPrevented).toBe(false);
    textarea.remove();
  });

  it('still intercepts Space from non-editable targets during a session', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A],
      gestureIds: new Set(['A']),
      altPressed: false,
    });

    const keydown = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(keydown);

    expect(keydown.defaultPrevented).toBe(true);
  });

  it('tracks Cmd or Ctrl as an explicit nested Frame entry override', () => {
    const node = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [node],
      gestureIds: new Set(['A']),
      altPressed: false,
    });

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }),
    );
    expect(isNestedFrameEntryAllowed()).toBe(true);

    endSnapSession();
    expect(consumeLastNestedFrameEntryAllowed()).toBe(true);
    expect(isNestedFrameEntryAllowed()).toBe(false);
  });

  it('invalidates a cached Frame decision when Cmd or Ctrl changes', () => {
    const node = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [node],
      gestureIds: new Set(['A']),
      altPressed: false,
    });
    writeDragDecision('A', { unframe: false, enterFrameId: null });

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Control', bubbles: true }),
    );
    endSnapSession();

    expect(consumeLastDragDecisions()).toBeNull();
  });

  it('keeps the current preview decision across repeated modifier keydown', () => {
    const node = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [node],
      gestureIds: new Set(['A']),
      altPressed: false,
    });
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }),
    );
    writeDragDecision('A', { unframe: false, enterFrameId: 'target' });

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Meta',
        repeat: true,
        bubbles: true,
      }),
    );
    endSnapSession();

    expect(consumeLastDragDecisions()?.get('A')).toEqual({
      unframe: false,
      enterFrameId: 'target',
    });
  });
});

describe('snapSession — mixed parents disable snap', () => {
  it('isActive is false when dragged ids span multiple parents', () => {
    const frame1 = makeNode(
      'F1',
      { x: 0, y: 0 },
      { w: 500, h: 500 },
      { type: 'frame' },
    );
    const frame2 = makeNode(
      'F2',
      { x: 1000, y: 0 },
      { w: 500, h: 500 },
      { type: 'frame' },
    );
    const child1 = makeNode(
      'C1',
      { x: 10, y: 10 },
      { w: 50, h: 50 },
      { parentId: 'F1' },
    );
    const child2 = makeNode(
      'C2',
      { x: 10, y: 10 },
      { w: 50, h: 50 },
      { parentId: 'F2' },
    );

    beginSnapSession({
      nodes: [frame1, frame2, child1, child2],
      gestureIds: new Set(['C1', 'C2']),
      altPressed: false,
    });

    expect(isSnapSessionActive()).toBe(false);
  });
});

describe('snapSession — applySnap', () => {
  beforeEach(() => {
    useGesturePreviewStore.getState().clearSnapGuides();
  });

  it('returns the input unchanged when no session is active', () => {
    const changes = [posChange('X', { x: 5, y: 5 }, true)];
    expect(applySnap(changes, 1)).toBe(changes);
  });

  it('rewrites a dragged position to snap onto a sibling edge', () => {
    // A=[0,50]. Drag B from x=51 — should snap left-edge to A.right=50
    // (deltaX = -1). T = SNAP_THRESHOLD_SCREEN_PX = 6 at zoom 1.
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 51, y: 0 }, { w: 50, h: 50 });

    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
    });

    const changes = [posChange('B', { x: 51, y: 0 }, true)];
    const result = applySnap(changes, 1) as NodePositionChange[];

    // Snapped to x = 50 (delta -1).
    expect(result[0].position).toEqual({ x: 50, y: 0 });
    // Guides should have been pushed.
    expect(useGesturePreviewStore.getState().snapGuides.length).toBeGreaterThan(
      0,
    );
  });

  it('passes through non-drag position changes untouched', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 51, y: 0 }, { w: 50, h: 50 });

    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
    });

    // dragging:false simulates the final commit, which we DO rewrite
    // (so that the release lands at the snapped position). Use
    // dragging:undefined for a "programmatic" position change which
    // must be left alone.
    const programmatic = {
      type: 'position' as const,
      id: 'B',
      position: { x: 51, y: 0 },
      // No `dragging` key — not a drag tick.
    };
    const result = applySnap([programmatic], 1);
    expect(result[0]).toBe(programmatic);
  });

  it('respects altPressed = true (bypass) at begin', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 51, y: 0 }, { w: 50, h: 50 });

    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: true,
    });

    const changes = [posChange('B', { x: 51, y: 0 }, true)];
    const result = applySnap(changes, 1) as NodePositionChange[];
    // Bypass active — position stays raw.
    expect(result[0].position).toEqual({ x: 51, y: 0 });
  });
});

describe('snapSession — isSnapSessionDragEndCommit', () => {
  it('is false when no session is active', () => {
    expect(
      isSnapSessionDragEndCommit([posChange('X', { x: 0, y: 0 }, false)]),
    ).toBe(false);
  });

  it('is true when a dragging:false change for a tracked id appears', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 200, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
    });

    expect(
      isSnapSessionDragEndCommit([posChange('B', { x: 200, y: 0 }, false)]),
    ).toBe(true);
  });

  it('is false for dragging:true (live ticks) on the same id', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 200, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
    });

    expect(
      isSnapSessionDragEndCommit([posChange('B', { x: 200, y: 0 }, true)]),
    ).toBe(false);
  });

  it('is false for a dragging:false change on an id we do not track', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 200, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
    });

    // 'Z' was never part of the dragged set.
    expect(
      isSnapSessionDragEndCommit([posChange('Z', { x: 0, y: 0 }, false)]),
    ).toBe(false);
  });
});

// ── Resize lifecycle ─────────────────────────────────────────────────

function dimChange(
  id: string,
  dim: { width: number; height: number },
  resizing: boolean,
): NodeDimensionChange {
  return {
    type: 'dimensions',
    id,
    dimensions: dim,
    resizing,
  };
}

describe('snapSession — resize lifecycle', () => {
  /**
   * Layout (anchor A on the left, B is the one being resized via
   * its LEFT handle so the left edge can snap onto A.right=50):
   *
   *   ┌───A───┐  ┌───────B───────┐
   *   │       │  │               │
   *   └───────┘  └───────────────┘
   *   x=0..50    x=51..151
   */
  function fixture() {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 51, y: 0 }, { w: 100, h: 50 });
    return { A, B };
  }

  function beginResize(B: NestableNode) {
    beginSnapSession({
      nodes: [fixture().A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
      kind: 'resize',
      resizeContext: {
        nodeId: 'B',
        startRect: { x: 51, y: 0, w: 100, h: 50 },
        startLocalPos: { x: 51, y: 0 },
        parentOffset: { x: 0, y: 0 },
      },
    });
  }

  it('normalises an aspect-locked resize proposal to the starting ratio', () => {
    const { A, B } = fixture();
    beginSnapSession({
      nodes: [A, B],
      gestureIds: new Set(['B']),
      altPressed: false,
      kind: 'resize',
      resizeContext: {
        nodeId: 'B',
        startRect: { x: 51, y: 0, w: 100, h: 50 },
        startLocalPos: { x: 51, y: 0 },
        parentOffset: { x: 0, y: 0 },
        lockAspect: true,
      },
    });

    const snapped = applyResizeProposal(
      { x: 51, y: 0, width: 200, height: 75 },
      1,
    );

    expect(snapped).toEqual({ x: 51, y: 0, width: 200, height: 100 });
    expect(getResizeSnappedRect()).toEqual({
      local: { x: 51, y: 0 },
      size: { width: 200, height: 100 },
    });
  });

  it('applyResizeProposal snaps the moving left edge onto A.right', () => {
    const { B } = fixture();
    beginResize(B);

    // Drag the left handle: x slides from 51 → 50, width grows 100 → 101.
    // Engine should detect ‘min’ on X and snap onto A.right=50 → no
    // additional delta (already at 50).
    // Use x=50, w=101 to mimic a 1-px overshoot scenario.
    const snapped = applyResizeProposal(
      { x: 50, y: 0, width: 101, height: 50 },
      1,
    );

    // Already aligned, no delta. The cached snapped rect equals the input.
    expect(snapped).toEqual({ x: 50, y: 0, width: 101, height: 50 });
    expect(getResizeSnappedRect()).toEqual({
      local: { x: 50, y: 0 },
      size: { width: 101, height: 50 },
    });
  });

  it('applyResizeProposal anchors the non-moving (right) edge when snapping the left edge', () => {
    const { B } = fixture();
    beginResize(B);

    // Drag left handle to x=49 (overshoots A.right=50 by 1 px on the
    // wrong side). Engine should pull x back to 50 → deltaX=+1.
    // For ‘min’ active: snappedX = 49 + 1 = 50, snappedW = 101 - 1 = 100.
    const snapped = applyResizeProposal(
      { x: 49, y: 0, width: 102, height: 50 },
      1,
    );

    expect(snapped.x).toBe(50);
    expect(snapped.width).toBe(101); // anchor at right edge x=151
  });

  it('applyResizeProposal only grows on the right when right handle is dragged', () => {
    // Layout: A=[0,50], B=[100..200] — right edge of B at 200.
    // Add a sibling C at x=201 so B.right can snap onto C.left=201.
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 100, y: 0 }, { w: 100, h: 50 });
    const C = makeNode('C', { x: 201, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A, B, C],
      gestureIds: new Set(['B']),
      altPressed: false,
      kind: 'resize',
      resizeContext: {
        nodeId: 'B',
        startRect: { x: 100, y: 0, w: 100, h: 50 },
        startLocalPos: { x: 100, y: 0 },
        parentOffset: { x: 0, y: 0 },
      },
    });

    // Drag right handle: width overshoots 100 → 102 (right edge x=202).
    // Engine should pull it back onto C.left=201 → deltaX = -1.
    // For ‘max’ active: position untouched, width shrinks by 1 to 101.
    const snapped = applyResizeProposal(
      { x: 100, y: 0, width: 102, height: 50 },
      1,
    );

    expect(snapped.x).toBe(100); // anchor preserved
    expect(snapped.width).toBe(101); // snapped to align right edge to 201
  });

  it('applySnap (resize) rewrites both dim and pos changes from the cached snap', () => {
    const { B } = fixture();
    beginResize(B);

    // Run a snap pass that pulls left from 49 → 50, shrinks width 102 → 101.
    applyResizeProposal({ x: 49, y: 0, width: 102, height: 50 }, 1);

    // Simulate RF emitting raw dim+pos changes for the same frame.
    const raw: NodeChange[] = [
      dimChange('B', { width: 102, height: 50 }, true),
      { type: 'position', id: 'B', position: { x: 49, y: 0 } },
    ];
    const out = applySnap(raw, 1);

    const dim = out.find((c) => c.type === 'dimensions') as NodeDimensionChange;
    const pos = out.find((c) => c.type === 'position') as NodePositionChange;
    expect(dim.dimensions).toEqual({ width: 101, height: 50 });
    expect(pos.position).toEqual({ x: 50, y: 0 });
  });

  it('applySnap (resize) preserves the final resizing:false flag', () => {
    const { B } = fixture();
    beginResize(B);
    applyResizeProposal({ x: 50, y: 0, width: 101, height: 50 }, 1);

    const raw: NodeChange[] = [
      dimChange('B', { width: 101, height: 50 }, false),
    ];
    const out = applySnap(raw, 1);
    const dim = out[0] as NodeDimensionChange;
    expect(dim.resizing).toBe(false);
    expect(dim.dimensions).toEqual({ width: 101, height: 50 });
  });

  it('applySnap (resize) passes changes through when no proposal has been processed', () => {
    const { B } = fixture();
    beginResize(B);
    // No applyResizeProposal call → _lastResizeSnapped is null.
    const raw: NodeChange[] = [
      dimChange('B', { width: 102, height: 50 }, true),
    ];
    const out = applySnap(raw, 1);
    expect(out).toBe(raw);
  });

  it('applySnap (resize) leaves unrelated nodes untouched', () => {
    const { B } = fixture();
    beginResize(B);
    applyResizeProposal({ x: 50, y: 0, width: 101, height: 50 }, 1);

    const unrelatedDim = dimChange('A', { width: 999, height: 999 }, true);
    const out = applySnap([unrelatedDim], 1);
    expect(out[0]).toBe(unrelatedDim);
  });

  it('isSnapSessionResizeEndCommit detects the resizing:false commit for the tracked node', () => {
    const { B } = fixture();
    beginResize(B);
    expect(
      isSnapSessionResizeEndCommit([
        dimChange('B', { width: 101, height: 50 }, false),
      ]),
    ).toBe(true);
    // Live frame doesn’t count.
    expect(
      isSnapSessionResizeEndCommit([
        dimChange('B', { width: 101, height: 50 }, true),
      ]),
    ).toBe(false);
  });

  it('isSnapSessionResizeEndCommit is false when no session is active', () => {
    expect(
      isSnapSessionResizeEndCommit([
        dimChange('B', { width: 1, height: 1 }, false),
      ]),
    ).toBe(false);
  });

  it('isSnapSessionResizeEndCommit is false while a drag session is active', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A],
      gestureIds: new Set(['A']),
      altPressed: false,
      // Default kind = 'drag'.
    });
    expect(
      isSnapSessionResizeEndCommit([
        dimChange('A', { width: 1, height: 1 }, false),
      ]),
    ).toBe(false);
  });

  it('endSnapSession clears resize context and cached snap', () => {
    const { B } = fixture();
    beginResize(B);
    applyResizeProposal({ x: 50, y: 0, width: 101, height: 50 }, 1);
    expect(getResizeContext()).not.toBeNull();
    expect(getResizeSnappedRect()).not.toBeNull();

    endSnapSession();
    expect(getResizeContext()).toBeNull();
    expect(getResizeSnappedRect()).toBeNull();
    expect(isSnapSessionActive()).toBe(false);
  });

  it('applyResizeProposal is a no-op outside a resize session', () => {
    // No begin — must return the raw rect unchanged and not cache.
    const raw = { x: 1, y: 2, width: 30, height: 40 };
    expect(applyResizeProposal(raw, 1)).toEqual(raw);
    expect(getResizeSnappedRect()).toBeNull();
  });

  it('applyResizeProposal is a no-op when the active session is a drag', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A],
      gestureIds: new Set(['A']),
      altPressed: false,
      // No kind => 'drag'
    });
    const raw = { x: 1, y: 2, width: 30, height: 40 };
    expect(applyResizeProposal(raw, 1)).toEqual(raw);
    expect(getResizeSnappedRect()).toBeNull();
  });
});
