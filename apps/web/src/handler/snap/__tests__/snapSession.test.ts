/**
 * @file Unit tests for `snapSession` — the gesture-scoped wrapper
 * around `snapEngine` that owns drag-time state for the canvas.
 *
 * These tests exercise the lifecycle (`begin` → `apply` → `end`)
 * directly against the real implementation. Side effects on
 * `dragPreviewStore` are observed by reading its state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDragPreviewStore } from '@/store/dragPreviewStore';

import {
  applySnap,
  beginSnapSession,
  endSnapSession,
  isSnapSessionActive,
  isSnapSessionDragEndCommit,
} from '../snapSession';

import type { NestableNode } from '../../canvasCommand/utils/frame';
import type { NodePositionChange } from '@xyflow/react';

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
      draggedIds: new Set(['B']),
      altPressed: false,
    });
    expect(isSnapSessionActive()).toBe(true);
  });

  it('end is idempotent and leaves the session inactive', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A],
      draggedIds: new Set(['A']),
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
      draggedIds: new Set(['B']),
      altPressed: false,
    });
    // Push some guide state so we can observe the cleanup.
    useDragPreviewStore
      .getState()
      .setSnapGuides([{ axis: 'x', value: 10, from: 0, to: 100 }]);
    expect(useDragPreviewStore.getState().snapGuides).toHaveLength(1);

    beginSnapSession({
      nodes: [A, B],
      draggedIds: new Set(['B']),
      altPressed: false,
    });
    // The defensive endSnapSession inside begin must have cleared
    // the previous gesture's guides.
    expect(useDragPreviewStore.getState().snapGuides).toEqual([]);
  });

  it('clears the dragPreviewStore guides on end', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    beginSnapSession({
      nodes: [A],
      draggedIds: new Set(['A']),
      altPressed: false,
    });
    useDragPreviewStore
      .getState()
      .setSnapGuides([{ axis: 'x', value: 10, from: 0, to: 100 }]);
    endSnapSession();
    expect(useDragPreviewStore.getState().snapGuides).toEqual([]);
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
      draggedIds: new Set(['C1', 'C2']),
      altPressed: false,
    });

    expect(isSnapSessionActive()).toBe(false);
  });
});

describe('snapSession — applySnap', () => {
  beforeEach(() => {
    useDragPreviewStore.getState().clearSnapGuides();
  });

  it('returns the input unchanged when no session is active', () => {
    const changes = [posChange('X', { x: 5, y: 5 }, true)];
    expect(applySnap(changes, 1)).toBe(changes);
  });

  it('rewrites a dragged position to snap onto a sibling edge', () => {
    // A=[0,50]. Drag B from x=51 → should snap left-edge to A.right=50
    // (deltaX = -1). T = SNAP_THRESHOLD_SCREEN_PX = 6 at zoom 1.
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 51, y: 0 }, { w: 50, h: 50 });

    beginSnapSession({
      nodes: [A, B],
      draggedIds: new Set(['B']),
      altPressed: false,
    });

    const changes = [posChange('B', { x: 51, y: 0 }, true)];
    const result = applySnap(changes, 1) as NodePositionChange[];

    // Snapped to x = 50 (delta -1).
    expect(result[0].position).toEqual({ x: 50, y: 0 });
    // Guides should have been pushed.
    expect(useDragPreviewStore.getState().snapGuides.length).toBeGreaterThan(0);
  });

  it('passes through non-drag position changes untouched', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 51, y: 0 }, { w: 50, h: 50 });

    beginSnapSession({
      nodes: [A, B],
      draggedIds: new Set(['B']),
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
      // No `dragging` key → not a drag tick.
    };
    const result = applySnap([programmatic], 1);
    expect(result[0]).toBe(programmatic);
  });

  it('respects altPressed = true (bypass) at begin', () => {
    const A = makeNode('A', { x: 0, y: 0 }, { w: 50, h: 50 });
    const B = makeNode('B', { x: 51, y: 0 }, { w: 50, h: 50 });

    beginSnapSession({
      nodes: [A, B],
      draggedIds: new Set(['B']),
      altPressed: true,
    });

    const changes = [posChange('B', { x: 51, y: 0 }, true)];
    const result = applySnap(changes, 1) as NodePositionChange[];
    // Bypass active → position stays raw.
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
      draggedIds: new Set(['B']),
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
      draggedIds: new Set(['B']),
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
      draggedIds: new Set(['B']),
      altPressed: false,
    });

    // 'Z' was never part of the dragged set.
    expect(
      isSnapSessionDragEndCommit([posChange('Z', { x: 0, y: 0 }, false)]),
    ).toBe(false);
  });
});
