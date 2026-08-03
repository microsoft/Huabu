/**
 * @file Tests for sketchMerge — pure-geometry helpers used by
 * `SketchOverlay` to fold consecutive strokes into one node and to
 * surgically remove individual strokes with the eraser.
 *
 * The helpers read `useCanvasStore.getState().nodes`, so we mock the
 * store module to a tiny shim that returns whatever we set in `nodes`
 * before each test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX } from '@/config/canvas';

import {
  buildEraseCommands,
  buildMergeCommands,
  buildMoveStrokesCommands,
  findMergeTarget,
} from '../sketchMerge';

import type { Node } from '@xyflow/react';

// ── Store mock ─────────────────────────────────────────────────────────
//
// `sketchMerge.ts` calls `useCanvasStore.getState().nodes`. We mock the
// module with a tiny object that exposes the same `getState` shape; each
// test rewrites `nodes` via the helper below.

let mockNodes: Node[] = [];

vi.mock('@/store/canvasStore', () => ({
  default: {
    getState: () => ({ nodes: mockNodes }),
  },
}));

function setNodes(nodes: Node[]): void {
  mockNodes = nodes;
}

beforeEach(() => {
  setNodes([]);
});

// ── Sketch-node factory ────────────────────────────────────────────────

interface SketchNodeArgs {
  id: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  /** Reference (initial) size — defaults to current size (scale = 1). */
  initialSize?: { width: number; height: number };
  parentId?: string;
  strokes: Array<{
    id: string;
    points: number[][];
    color?: string;
    size?: number;
    createdAt: number;
  }>;
}

function makeSketch(args: SketchNodeArgs): Node {
  const initialSize = args.initialSize ?? args.size;
  return {
    id: args.id,
    type: 'sketch',
    position: args.position,
    width: args.size.width,
    height: args.size.height,
    measured: { width: args.size.width, height: args.size.height },
    parentId: args.parentId,
    data: {
      type: 'sketch',
      strokes: args.strokes.map((s) => ({
        id: s.id,
        points: s.points,
        color: s.color ?? '#000000',
        size: s.size ?? 4,
        createdAt: s.createdAt,
      })),
      initialSize,
    },
  } as unknown as Node;
}

// =====================================================================
// findMergeTarget
// =====================================================================

describe('findMergeTarget', () => {
  const NOW = 1_000_000;
  const FLOW_THRESHOLD = SKETCH_STROKE_MERGE_MAX_DISTANCE_SCREEN_PX; // zoom = 1

  it('returns null when there are no sketch nodes', () => {
    setNodes([]);
    const got = findMergeTarget(
      { x: 0, y: 0, width: 50, height: 50 },
      null,
      FLOW_THRESHOLD,
    );
    expect(got).toBeNull();
  });

  it('merges into a spatially-near region no matter how long ago it was drawn', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        strokes: [
          {
            id: 's1',
            points: [[0, 0]],
            // Drawn ten minutes ago — the old time window would have
            // rejected this; purely spatial merging still folds in.
            createdAt: NOW - 10 * 60 * 1000,
          },
        ],
      }),
    ]);
    const got = findMergeTarget(
      { x: 50, y: 50, width: 10, height: 10 }, // overlapping bbox
      null,
      FLOW_THRESHOLD,
    );
    expect(got).toBe('a');
  });

  it('returns null when the only candidate is farther than maxDistance', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's1', points: [[0, 0]], createdAt: NOW }],
      }),
    ]);
    const got = findMergeTarget(
      // bbox starts well past `0 + 50 + FLOW_THRESHOLD` on the X axis
      { x: 50 + FLOW_THRESHOLD + 5, y: 0, width: 10, height: 10 },
      null,
      FLOW_THRESHOLD,
    );
    expect(got).toBeNull();
  });

  it('matches an overlapping bbox (zero distance)', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        strokes: [{ id: 's1', points: [[0, 0]], createdAt: NOW }],
      }),
    ]);
    const got = findMergeTarget(
      { x: 50, y: 50, width: 10, height: 10 },
      null,
      FLOW_THRESHOLD,
    );
    expect(got).toBe('a');
  });

  it('refuses to merge across parent frames', () => {
    setNodes([
      // top-level candidate — overlaps spatially but in a different
      // coord space (parent-local) once we set parentId on the new stroke.
      makeSketch({
        id: 'top-level',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        strokes: [{ id: 's1', points: [[0, 0]], createdAt: NOW }],
      }),
      // parented candidate — same numeric position but `parentId` set.
      makeSketch({
        id: 'in-frame',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        parentId: 'frame-1',
        strokes: [{ id: 's2', points: [[0, 0]], createdAt: NOW }],
      }),
    ]);
    // Looking for a top-level merge target → only `top-level` is eligible.
    expect(
      findMergeTarget(
        { x: 10, y: 10, width: 5, height: 5 },
        null,
        FLOW_THRESHOLD,
      ),
    ).toBe('top-level');
    // Looking for a merge inside `frame-1` → only `in-frame` is eligible.
    expect(
      findMergeTarget(
        { x: 10, y: 10, width: 5, height: 5 },
        'frame-1' as never,
        FLOW_THRESHOLD,
      ),
    ).toBe('in-frame');
  });

  it('picks the spatially nearest region, not the most recent', () => {
    setNodes([
      makeSketch({
        id: 'recent-far',
        position: { x: 200, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's1', points: [[0, 0]], createdAt: NOW }], // most recent
      }),
      makeSketch({
        id: 'old-near',
        position: { x: 0, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's2', points: [[0, 0]], createdAt: NOW - 5000 }], // older
      }),
    ]);
    const got = findMergeTarget(
      // dist to old-near = 5, to recent-far = 135 → nearest wins despite age
      { x: 55, y: 0, width: 10, height: 10 },
      null,
      300,
    );
    expect(got).toBe('old-near');
  });

  it('picks the closer of two candidates', () => {
    setNodes([
      makeSketch({
        id: 'far',
        position: { x: 200, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's1', points: [[0, 0]], createdAt: NOW }],
      }),
      makeSketch({
        id: 'near',
        position: { x: 100, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's2', points: [[0, 0]], createdAt: NOW }],
      }),
    ]);
    const got = findMergeTarget(
      { x: 0, y: 0, width: 60, height: 50 }, // distance: near=40, far=140
      null,
      300,
    );
    expect(got).toBe('near');
  });

  it('honours measured.width over node.width when both exist', () => {
    // Node.measured wins; if it didn't, the candidate bbox would only
    // extend to x=50 and the new stroke at x=120 would be out of range.
    setNodes([
      {
        ...makeSketch({
          id: 'a',
          position: { x: 0, y: 0 },
          size: { width: 50, height: 50 },
          strokes: [{ id: 's1', points: [[0, 0]], createdAt: NOW }],
        }),
        measured: { width: 150, height: 50 },
      } as Node,
    ]);
    const got = findMergeTarget(
      { x: 120, y: 0, width: 10, height: 10 },
      null,
      FLOW_THRESHOLD,
    );
    expect(got).toBe('a');
  });
});

// =====================================================================
// buildMergeCommands
// =====================================================================

describe('buildMergeCommands', () => {
  const NOW = 2_000_000;

  it('returns [] when target node does not exist', () => {
    setNodes([]);
    const cmds = buildMergeCommands(
      'missing' as never,
      null,
      [[0, 0]],
      { x: 0, y: 0, width: 10, height: 10 },
      '#000',
      4,
      NOW,
      'new-stroke',
    );
    expect(cmds).toEqual([]);
  });

  it('refuses (and warns) when expectedParentId disagrees with the node', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        parentId: 'frame-1',
        strokes: [{ id: 's1', points: [[0, 0]], createdAt: NOW }],
      }),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cmds = buildMergeCommands(
      'a' as never,
      null, // wrong: actually parented under frame-1
      [[0, 0]],
      { x: 0, y: 0, width: 10, height: 10 },
      '#000',
      4,
      NOW,
      'new-stroke',
    );
    expect(cmds).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('produces MERGE_NODE_DATA + SET_NODE_GEOMETRY with union bbox (unscaled, non-overlapping)', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        strokes: [{ id: 's1', points: [[10, 10]], createdAt: NOW }],
      }),
    ]);
    // New stroke off to the right + below; bbox at (200, 150) size 50×40.
    const cmds = buildMergeCommands(
      'a' as never,
      null,
      [[0, 0]], // new stroke local-to-its-own-bbox
      { x: 200, y: 150, width: 50, height: 40 },
      '#ff0000',
      6,
      NOW,
      'new-stroke',
    );
    expect(cmds).toHaveLength(2);
    expect(cmds[0].type).toBe('MERGE_NODE_DATA');
    expect(cmds[1].type).toBe('SET_NODE_GEOMETRY');

    // Union: x in [0, 250], y in [0, 190] → 250 × 190 at (0, 0).
    const geom = cmds[1] as Extract<
      (typeof cmds)[number],
      { type: 'SET_NODE_GEOMETRY' }
    >;
    expect(geom.items).toEqual([
      {
        nodeId: 'a',
        position: { x: 0, y: 0 },
        size: { width: 250, height: 190 },
      },
    ]);

    const merge = cmds[0] as Extract<
      (typeof cmds)[number],
      { type: 'MERGE_NODE_DATA' }
    >;
    const patch = merge.patches[0].patch as {
      strokes: Array<{ id: string; points: number[][] }>;
      initialSize: { width: number; height: number };
    };
    expect(patch.initialSize).toEqual({ width: 250, height: 190 });
    // Existing stroke kept its (10, 10) point — node.position was (0, 0)
    // and the new union origin is (0, 0), so no shift.
    expect(patch.strokes[0]).toMatchObject({ id: 's1', points: [[10, 10]] });
    // New stroke is shifted by (200, 150) from local (0, 0) → (200, 150).
    expect(patch.strokes[1]).toMatchObject({
      id: 'new-stroke',
      color: '#ff0000',
      size: 6,
      createdAt: NOW,
      points: [[200, 150]],
    });
  });

  it('bakes the existing scale into the existing strokes (resized node)', () => {
    // Node was created at 100×100 (initialSize) but user resized to
    // 200×100 → scaleX = 2, scaleY = 1. The existing point (50, 50) in
    // node-local coords therefore lives at flow (100, 50).
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 100 },
        initialSize: { width: 100, height: 100 },
        strokes: [{ id: 's1', points: [[50, 50]], createdAt: NOW }],
      }),
    ]);
    // New stroke at flow (210, 0) size 30×30 — just past the resized bbox.
    const cmds = buildMergeCommands(
      'a' as never,
      null,
      [[0, 0]],
      { x: 210, y: 0, width: 30, height: 30 },
      '#000',
      4,
      NOW,
      'n',
    );
    const merge = cmds[0] as Extract<
      (typeof cmds)[number],
      { type: 'MERGE_NODE_DATA' }
    >;
    const patch = merge.patches[0].patch as {
      strokes: Array<{ id: string; points: number[][] }>;
      initialSize: { width: number; height: number };
    };
    // Union bbox: x ∈ [0, 240], y ∈ [0, 100].
    expect(patch.initialSize).toEqual({ width: 240, height: 100 });
    // Existing stroke baked: (50 * 2, 50 * 1) + shift(0, 0) = (100, 50).
    // The flow position of the original point should be preserved.
    expect(patch.strokes[0].points[0]).toEqual([100, 50]);
    // New stroke shifted by (210, 0) → (210, 0).
    expect(patch.strokes[1].points[0]).toEqual([210, 0]);
  });

  it('uses persisted style size when the node is unmounted (no measured / node.width)', () => {
    // Regression: a scaled sketch loaded from disk but not yet mounted has
    // only `style` geometry (persisted by the canvas engine, possibly as a
    // CSS string) — no `measured`, no top-level `node.width`. The hit-test
    // already resolves the rendered size via getSketchRenderedSize
    // (measured → node.width → style → initialSize); the merge builder must
    // read the SAME size, otherwise it would fall back to initialSize
    // (scale = 1) and bake / persist the strokes at the wrong scale.
    //
    // initialSize 100×100, style 200×100 → scaleX = 2, scaleY = 1. If the
    // builder ignored style it would emit scale = 1 and place the existing
    // point at (50, 50) with a 100-wide bbox.
    setNodes([
      {
        id: 'a',
        type: 'sketch',
        position: { x: 0, y: 0 },
        // No `measured`, no `width` / `height` — only persisted `style`,
        // written as a CSS-length string to also exercise parseDimension.
        style: { width: '200px', height: '100px' },
        data: {
          type: 'sketch',
          strokes: [
            {
              id: 's1',
              points: [[50, 50]],
              color: '#000',
              size: 4,
              createdAt: NOW,
            },
          ],
          initialSize: { width: 100, height: 100 },
        },
      } as unknown as Node,
    ]);
    const cmds = buildMergeCommands(
      'a' as never,
      null,
      [[0, 0]],
      { x: 210, y: 0, width: 30, height: 30 },
      '#000',
      4,
      NOW,
      'n',
    );
    const merge = cmds[0] as Extract<
      (typeof cmds)[number],
      { type: 'MERGE_NODE_DATA' }
    >;
    const patch = merge.patches[0].patch as {
      strokes: Array<{ id: string; points: number[][] }>;
      initialSize: { width: number; height: number };
    };
    // Union bbox: x ∈ [0, 240], y ∈ [0, 100] — proves style width (200)
    // drove the resized bbox, not initialSize (100).
    expect(patch.initialSize).toEqual({ width: 240, height: 100 });
    // Existing stroke baked with style-derived scale: (50 * 2, 50 * 1).
    expect(patch.strokes[0].points[0]).toEqual([100, 50]);
    // New stroke shifted by (210, 0).
    expect(patch.strokes[1].points[0]).toEqual([210, 0]);
  });

  it('preserves world coordinates when an outside stroke expands the bbox past stale measured dimensions', () => {
    setNodes([
      {
        id: 'a',
        type: 'sketch',
        position: { x: 100, y: 100 },
        style: { width: 100.25, height: 50.5 },
        measured: { width: 100, height: 50 },
        data: {
          type: 'sketch',
          strokes: [
            {
              id: 's1',
              points: [[50, 25]],
              color: '#000',
              size: 4,
              createdAt: NOW,
            },
          ],
          initialSize: { width: 100, height: 50 },
        },
      } as unknown as Node,
    ]);

    const cmds = buildMergeCommands(
      'a' as never,
      null,
      [[0, 0]],
      { x: 90, y: 90, width: 5, height: 5 },
      '#000',
      4,
      NOW,
      'n',
    );
    const merge = cmds[0] as Extract<
      (typeof cmds)[number],
      { type: 'MERGE_NODE_DATA' }
    >;
    const geometry = cmds[1] as Extract<
      (typeof cmds)[number],
      { type: 'SET_NODE_GEOMETRY' }
    >;
    const patch = merge.patches[0].patch as {
      strokes: Array<{ points: number[][] }>;
    };

    const mergedOrigin = geometry.items[0].position;
    const bakedPoint = patch.strokes[0].points[0];
    expect(mergedOrigin).toBeDefined();
    if (!mergedOrigin) throw new Error('Expected merged geometry position');
    expect(mergedOrigin.x + bakedPoint[0]).toBeCloseTo(150.125, 10);
    expect(mergedOrigin.y + bakedPoint[1]).toBeCloseTo(125.25, 10);
  });

  it('preserves the third (pressure) tuple component on baked points', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        strokes: [{ id: 's1', points: [[10, 10, 0.7]], createdAt: NOW }],
      }),
    ]);
    const cmds = buildMergeCommands(
      'a' as never,
      null,
      [[0, 0, 0.5]],
      { x: 200, y: 0, width: 20, height: 20 },
      '#000',
      4,
      NOW,
      'n',
    );
    const patch = (
      cmds[0] as Extract<(typeof cmds)[number], { type: 'MERGE_NODE_DATA' }>
    ).patches[0].patch as {
      strokes: Array<{ points: number[][] }>;
    };
    expect(patch.strokes[0].points[0]).toEqual([10, 10, 0.7]);
    expect(patch.strokes[1].points[0]).toEqual([200, 0, 0.5]);
  });
});

// =====================================================================
// buildEraseCommands
// =====================================================================

describe('buildEraseCommands', () => {
  const NOW = 3_000_000;

  it('returns [] when removedStrokeIds is empty', () => {
    expect(buildEraseCommands('a' as never, new Set())).toEqual([]);
  });

  it('returns [] when target node does not exist', () => {
    setNodes([]);
    expect(buildEraseCommands('missing' as never, new Set(['s1']))).toEqual([]);
  });

  it('returns [] silently when removed ids match no current stroke (no-op)', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's1', points: [[0, 0]], createdAt: NOW }],
      }),
    ]);
    // 's-other' isn't on the node — `remaining.length === strokes.length`.
    expect(buildEraseCommands('a' as never, new Set(['s-other']))).toEqual([]);
  });

  it('returns DELETE_NODES when every stroke is removed', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [
          { id: 's1', points: [[0, 0]], createdAt: NOW },
          { id: 's2', points: [[10, 10]], createdAt: NOW },
        ],
      }),
    ]);
    const cmds = buildEraseCommands('a' as never, new Set(['s1', 's2']));
    expect(cmds).toEqual([{ type: 'DELETE_NODES', nodeIds: ['a'] }]);
  });

  it('reframes survivors tightly with per-stroke padding', () => {
    // Node at flow origin (10, 20), size 100×80 (no resize).
    // Two strokes:
    //   's1' size 4 at local (0, 0) — getting erased.
    //   's2' size 8 at local (50, 30) — survivor.
    // Padding for survivor = 8/2 = 4. Survivor flow point: (60, 50).
    // Tight bbox: [60-4, 50-4]–[60+4, 50+4] = (56, 46)–(64, 54) → 8×8.
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 10, y: 20 },
        size: { width: 100, height: 80 },
        strokes: [
          { id: 's1', points: [[0, 0]], size: 4, createdAt: NOW },
          { id: 's2', points: [[50, 30]], size: 8, createdAt: NOW },
        ],
      }),
    ]);
    const cmds = buildEraseCommands('a' as never, new Set(['s1']));
    expect(cmds).toHaveLength(2);
    const geom = cmds[1] as Extract<
      (typeof cmds)[number],
      { type: 'SET_NODE_GEOMETRY' }
    >;
    expect(geom.items).toEqual([
      {
        nodeId: 'a',
        position: { x: 56, y: 46 },
        size: { width: 8, height: 8 },
      },
    ]);
    const patch = (
      cmds[0] as Extract<(typeof cmds)[number], { type: 'MERGE_NODE_DATA' }>
    ).patches[0].patch as {
      strokes: Array<{ id: string; points: number[][] }>;
      initialSize: { width: number; height: number };
    };
    expect(patch.initialSize).toEqual({ width: 8, height: 8 });
    // Survivor's local point in the new frame: (60-56, 50-46) = (4, 4).
    expect(patch.strokes).toHaveLength(1);
    expect(patch.strokes[0]).toMatchObject({ id: 's2', points: [[4, 4]] });
  });

  it('bakes the current scale into survivor coords (resized node)', () => {
    // Initial 100×100, currently 200×100 → scaleX = 2, scaleY = 1.
    // Surviving stroke local point (50, 50) maps to flow
    // (10 + 50*2, 20 + 50*1) = (110, 70). Padding 0 (size 0 here).
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 10, y: 20 },
        size: { width: 200, height: 100 },
        initialSize: { width: 100, height: 100 },
        strokes: [
          { id: 's1', points: [[0, 0]], size: 0, createdAt: NOW },
          { id: 's2', points: [[50, 50]], size: 0, createdAt: NOW },
        ],
      }),
    ]);
    const cmds = buildEraseCommands('a' as never, new Set(['s1']));
    const geom = cmds[1] as Extract<
      (typeof cmds)[number],
      { type: 'SET_NODE_GEOMETRY' }
    >;
    // Single point survivor → degenerate bbox at (110, 70), size 0×0.
    expect(geom.items[0].position).toEqual({ x: 110, y: 70 });
    const patch = (
      cmds[0] as Extract<(typeof cmds)[number], { type: 'MERGE_NODE_DATA' }>
    ).patches[0].patch as {
      strokes: Array<{ id: string; points: number[][] }>;
    };
    // Survivor re-rooted at the new origin → (0, 0) local.
    expect(patch.strokes[0].points[0]).toEqual([0, 0]);
  });

  it('falls back to DELETE_NODES when all survivors are degenerate (empty point arrays)', () => {
    // Survivor exists but has no points, so the tight bbox loop never
    // runs and x1 stays Infinity → buildEraseCommands defensively wipes
    // the node.
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [
          { id: 's1', points: [[10, 10]], createdAt: NOW },
          { id: 's2', points: [], createdAt: NOW },
        ],
      }),
    ]);
    const cmds = buildEraseCommands('a' as never, new Set(['s1']));
    expect(cmds).toEqual([{ type: 'DELETE_NODES', nodeIds: ['a'] }]);
  });
});

// =====================================================================
// buildMoveStrokesCommands
// =====================================================================

describe('buildMoveStrokesCommands', () => {
  const NOW = 4_000_000;

  it('returns [] when no strokes are moved', () => {
    expect(buildMoveStrokesCommands('a' as never, new Set(), 5, 5)).toEqual([]);
  });

  it('returns [] when the delta is zero', () => {
    expect(
      buildMoveStrokesCommands('a' as never, new Set(['s1']), 0, 0),
    ).toEqual([]);
  });

  it('returns [] when the target node does not exist', () => {
    setNodes([]);
    expect(
      buildMoveStrokesCommands('missing' as never, new Set(['s1']), 5, 5),
    ).toEqual([]);
  });

  it('translates the moved stroke and reframes the union bbox', () => {
    // Node at flow origin (10, 20), size 100×100 (scale = 1).
    //   's1' (moved) size 0 at local (0, 0)   → flow (10, 20).
    //   's2' (kept)  size 0 at local (40, 40) → flow (50, 60).
    // Move s1 by (+30, +10): s1 flow → (40, 30). s2 stays (50, 60).
    // Union bbox: (40, 30)–(50, 60) → 10×30, origin (40, 30).
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 10, y: 20 },
        size: { width: 100, height: 100 },
        strokes: [
          { id: 's1', points: [[0, 0]], size: 0, createdAt: NOW },
          { id: 's2', points: [[40, 40]], size: 0, createdAt: NOW },
        ],
      }),
    ]);
    const cmds = buildMoveStrokesCommands(
      'a' as never,
      new Set(['s1']),
      30,
      10,
    );
    expect(cmds).toHaveLength(2);

    const geom = cmds[1] as Extract<
      (typeof cmds)[number],
      { type: 'SET_NODE_GEOMETRY' }
    >;
    expect(geom.items).toEqual([
      {
        nodeId: 'a',
        position: { x: 40, y: 30 },
        size: { width: 10, height: 30 },
      },
    ]);

    const patch = (
      cmds[0] as Extract<(typeof cmds)[number], { type: 'MERGE_NODE_DATA' }>
    ).patches[0].patch as {
      strokes: Array<{ id: string; points: number[][] }>;
      initialSize: { width: number; height: number };
    };
    expect(patch.initialSize).toEqual({ width: 10, height: 30 });
    // Re-rooted at new origin (40, 30):
    //   s1 flow (40, 30) → local (0, 0).
    //   s2 flow (50, 60) → local (10, 30).
    const s1 = patch.strokes.find((s) => s.id === 's1');
    const s2 = patch.strokes.find((s) => s.id === 's2');
    expect(s1?.points).toEqual([[0, 0]]);
    expect(s2?.points).toEqual([[10, 30]]);
  });

  it('bakes the current scale into moved and kept strokes (resized node)', () => {
    // Initial 100×100, currently 200×100 → scaleX = 2, scaleY = 1.
    //   's1' (moved) local (10, 10) → flow (10 + 20, 20 + 10) = (30, 30).
    //   's2' (kept)  local (50, 50) → flow (10 + 100, 20 + 50) = (110, 70).
    // Move s1 by (+10, +10): s1 flow → (40, 40). s2 stays (110, 70).
    // Union bbox: (40, 40)–(110, 70) → 70×30, origin (40, 40).
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 10, y: 20 },
        size: { width: 200, height: 100 },
        initialSize: { width: 100, height: 100 },
        strokes: [
          { id: 's1', points: [[10, 10]], size: 0, createdAt: NOW },
          { id: 's2', points: [[50, 50]], size: 0, createdAt: NOW },
        ],
      }),
    ]);
    const cmds = buildMoveStrokesCommands(
      'a' as never,
      new Set(['s1']),
      10,
      10,
    );
    const geom = cmds[1] as Extract<
      (typeof cmds)[number],
      { type: 'SET_NODE_GEOMETRY' }
    >;
    expect(geom.items[0].position).toEqual({ x: 40, y: 40 });
    expect(geom.items[0].size).toEqual({ width: 70, height: 30 });
  });
});
