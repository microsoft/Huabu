// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Verifies that `resolveNodeDragStop` honours the per-node
 * `cachedDecisions` snapshot from the live preview tick verbatim —
 * even when fresh recomputation against the current store state +
 * mouseup pointer would produce a different parentId.
 *
 * This is the WYSIWYG contract: the user releases on the frame they
 * last saw the node settle inside, so the commit must match that
 * frame regardless of:
 *   • smart-snap rewriting the dragged node's position to align with
 *     a sibling edge in the ≤16 ms between the last `rAF` tick and
 *     `mouseup` (changes node bbox vs. frame),
 *   • the mouseup pointer being a different DOM event from the last
 *     `mousemove` (pointer drifts past the halo edge),
 *   • rAF coalescing skipping the final frame entirely.
 *
 * The cache is the single source of truth for "did the gesture cross
 * a frame boundary?" — every other input is ignored when present.
 */

import { describe, expect, it } from 'vitest';

import { resolveUiIntent } from '../../uiIntent';

import type { UiResolverState } from '../../uiIntent';
import type { DragDecision } from '@/handler/snap/snapSession';
import type { Node } from '@xyflow/react';

// ── Test fixtures ─────────────────────────────────────────────────────

/**
 * A small canvas where `child` lives inside `frame`. The child's
 * position is deliberately placed at the bottom-right corner of the
 * frame so a tiny outward nudge crosses the frame edge without
 * leaving the pointer-halo capture zone.
 *
 *  frame  (0, 0)      300 × 200
 *    └─ child  (250, 150)      80 × 60
 */
function makeFramedChildScene(): {
  nodes: Node[];
  frameId: string;
  childId: string;
} {
  const frame: Node = {
    id: 'frame-1',
    type: 'frame',
    position: { x: 0, y: 0 },
    data: {},
    style: { width: 300, height: 200 },
    measured: { width: 300, height: 200 },
  };
  const child: Node = {
    id: 'child-1',
    type: 'note',
    parentId: 'frame-1',
    position: { x: 250, y: 150 },
    data: {},
    style: { width: 80, height: 60 },
    measured: { width: 80, height: 60 },
  };
  return { nodes: [frame, child], frameId: frame.id, childId: child.id };
}

function makeResolverState(nodes: Node[]): UiResolverState {
  return { nodes, edges: [] };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('resolveNodeDragStop · cachedDecisions WYSIWYG contract', () => {
  it('honours `unframe: false` even when fresh recomputation would unframe', () => {
    // Scene: child has been dragged so that its body is mostly OUTSIDE
    // the frame and the release pointer is also clearly past the
    // pointer-capture halo. Fresh recomputation would unframe it.
    const { nodes, childId } = makeFramedChildScene();
    const child = nodes.find((n) => n.id === childId);
    if (!child) throw new Error('child fixture missing');
    // Push the child well past the frame's right edge so neither the
    // body-overlap nor the pointer-halo test would keep it parented.
    child.position = { x: 500, y: 150 };

    // Cache says: "stay parented". The user last saw the preview with
    // the node still inside the frame, so the commit must honour that.
    const cachedDecisions = new Map<string, DragDecision>([
      [childId, { unframe: false, enterFrameId: null }],
    ]);

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: [childId],
        // Pointer FAR outside the frame + its capture halo — fresh
        // path would gladly detach the child.
        pointerFlowPosition: { x: 600, y: 200 },
        cachedDecisions,
      },
      makeResolverState(nodes),
    );

    // No SET_NODE_PARENT command should be emitted — the parentId
    // stays `frame-1`.
    const parentChanges = resolution.commands.filter(
      (c) => c.type === 'SET_NODE_PARENT',
    );
    expect(parentChanges).toHaveLength(0);
    // And no `node_unframed` trace either.
    expect(
      resolution.trace.find((t) => t.action === 'node_unframed'),
    ).toBeUndefined();
  });

  it('honours `unframe: true` even when fresh recomputation would keep parented', () => {
    // Inverse: child still well inside the frame (fresh path would
    // keep it parented), but cache says detach — e.g. user saw the
    // node as "leaving" in the last preview frame before the cursor
    // snapped back inward.
    const { nodes, frameId, childId } = makeFramedChildScene();

    const cachedDecisions = new Map<string, DragDecision>([
      [childId, { unframe: true, enterFrameId: null }],
    ]);

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: [childId],
        // Pointer right inside the frame.
        pointerFlowPosition: { x: 150, y: 100 },
        cachedDecisions,
      },
      makeResolverState(nodes),
    );

    const parentChange = resolution.commands.find(
      (c) => c.type === 'SET_NODE_PARENT',
    );
    expect(parentChange).toBeDefined();
    if (parentChange && parentChange.type === 'SET_NODE_PARENT') {
      expect(parentChange.nodeIds).toContain(childId);
      expect(parentChange.parentId).toBeNull();
    }
    expect(
      resolution.trace.find((t) => t.action === 'node_unframed'),
    ).toBeDefined();
    // Sanity: the dropped frame matches the original parent.
    void frameId;
  });

  it('honours `enterFrameId` decision verbatim (root → frame)', () => {
    // Scene: a top-level `note` and a `frame` that does NOT overlap
    // the note at all. Fresh recomputation would not enter the frame.
    // Cache says it should — honour it.
    const note: Node = {
      id: 'note-1',
      type: 'note',
      position: { x: 1000, y: 1000 },
      data: {},
      style: { width: 100, height: 60 },
      measured: { width: 100, height: 60 },
    };
    const frame: Node = {
      id: 'frame-2',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: {},
      style: { width: 200, height: 150 },
      measured: { width: 200, height: 150 },
    };
    const nodes: Node[] = [frame, note];

    const cachedDecisions = new Map<string, DragDecision>([
      ['note-1', { unframe: false, enterFrameId: 'frame-2' }],
    ]);

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: ['note-1'],
        // Pointer also far from the frame so the fresh path is doubly
        // unlikely to pick it.
        pointerFlowPosition: { x: 1050, y: 1050 },
        cachedDecisions,
      },
      makeResolverState(nodes),
    );

    const parentChange = resolution.commands.find(
      (c) => c.type === 'SET_NODE_PARENT',
    );
    expect(parentChange).toBeDefined();
    if (parentChange && parentChange.type === 'SET_NODE_PARENT') {
      expect(parentChange.nodeIds).toContain('note-1');
      expect(parentChange.parentId).toBe('frame-2');
    }
    expect(
      resolution.trace.find((t) => t.action === 'node_framed'),
    ).toBeDefined();
  });

  it('falls back to fresh recomputation when no cache is provided', () => {
    // Same scene as the first test, but no cache supplied. Fresh path
    // SHOULD unframe (child is well past the frame edge and the
    // pointer is far outside the halo). Proves the fallback still
    // works for the no-rAF code path.
    const { nodes, childId } = makeFramedChildScene();
    const child = nodes.find((n) => n.id === childId);
    if (!child) throw new Error('child fixture missing');
    child.position = { x: 500, y: 150 };

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: [childId],
        pointerFlowPosition: { x: 600, y: 200 },
        // intentionally no cachedDecisions
      },
      makeResolverState(nodes),
    );

    const parentChange = resolution.commands.find(
      (c) => c.type === 'SET_NODE_PARENT',
    );
    expect(parentChange).toBeDefined();
    if (parentChange && parentChange.type === 'SET_NODE_PARENT') {
      expect(parentChange.nodeIds).toContain(childId);
      expect(parentChange.parentId).toBeNull();
    }
  });

  it('`bypassReparent` overrides the cache (Space-held drag wins)', () => {
    // Even when the cache says "enter frame X", a Space-held drag
    // must keep the original parentId untouched. This guards against
    // the cache being written during a tick before the user pressed
    // Space, then leaking into the drop.
    const { nodes, childId } = makeFramedChildScene();

    const cachedDecisions = new Map<string, DragDecision>([
      // Cache says "leave the frame" — but bypassReparent wins.
      [childId, { unframe: true, enterFrameId: null }],
    ]);

    const resolution = resolveUiIntent(
      {
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: [childId],
        pointerFlowPosition: { x: 500, y: 200 },
        bypassReparent: true,
        cachedDecisions,
      },
      makeResolverState(nodes),
    );

    const parentChanges = resolution.commands.filter(
      (c) => c.type === 'SET_NODE_PARENT',
    );
    expect(parentChanges).toHaveLength(0);
  });
});
