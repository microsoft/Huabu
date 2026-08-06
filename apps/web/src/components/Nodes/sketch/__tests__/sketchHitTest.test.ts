// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for `findSketchStrokesInPolygon` — the Stage 2 stroke-level
 * lasso hit-test. Mirrors the store-mock pattern in `sketchMerge.test.ts`:
 * the helper reads `useCanvasStore.getState().nodes`, so we mock the store
 * to a shim that returns whatever we set before each test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  findSketchStrokesInPolygon,
  getSketchStrokeSelectionBounds,
} from '../sketchHitTest';

import type { Node } from '@xyflow/react';

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

interface SketchArgs {
  id: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  initialSize?: { width: number; height: number };
  strokes: Array<{ id: string; points: number[][]; size?: number }>;
}

function makeSketch(args: SketchArgs): Node {
  const initialSize = args.initialSize ?? args.size;
  return {
    id: args.id,
    type: 'sketch',
    position: args.position,
    width: args.size.width,
    height: args.size.height,
    measured: { width: args.size.width, height: args.size.height },
    data: {
      type: 'sketch',
      strokes: args.strokes.map((s) => ({
        id: s.id,
        points: s.points,
        color: '#000000',
        size: s.size ?? 4,
        createdAt: 0,
      })),
      initialSize,
    },
  } as unknown as Node;
}

// Axis-aligned rectangle polygon helper.
function rect(x1: number, y1: number, x2: number, y2: number) {
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

describe('findSketchStrokesInPolygon', () => {
  it('returns {} for a degenerate polygon', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        strokes: [{ id: 's1', points: [[10, 10]] }],
      }),
    ]);
    expect(findSketchStrokesInPolygon([{ x: 0, y: 0 }])).toEqual({});
  });

  it('captures only strokes with a point inside the polygon', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        strokes: [
          { id: 's1', points: [[10, 10]] }, // world (10,10)
          { id: 's2', points: [[90, 90]] }, // world (90,90)
        ],
      }),
    ]);
    // Top-left quadrant only.
    expect(findSketchStrokesInPolygon(rect(0, 0, 50, 50))).toEqual({
      a: ['s1'],
    });
  });

  it('captures strokes across multiple sketch nodes', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's1', points: [[10, 10]] }],
      }),
      makeSketch({
        id: 'b',
        position: { x: 100, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's2', points: [[10, 10]] }], // world (110,10)
      }),
    ]);
    expect(findSketchStrokesInPolygon(rect(-10, -10, 200, 200))).toEqual({
      a: ['s1'],
      b: ['s2'],
    });
  });

  it('omits nodes with no captured stroke', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 50, height: 50 },
        strokes: [{ id: 's1', points: [[10, 10]] }],
      }),
    ]);
    expect(findSketchStrokesInPolygon(rect(500, 500, 600, 600))).toEqual({});
  });

  it('accounts for node resize scale when mapping points to world space', () => {
    // initialSize 100×100 but rendered at 200×200 → scale 2. A stored
    // point at (50,50) lands at world (100,100).
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 200 },
        initialSize: { width: 100, height: 100 },
        strokes: [{ id: 's1', points: [[50, 50]] }],
      }),
    ]);
    expect(findSketchStrokesInPolygon(rect(90, 90, 110, 110))).toEqual({
      a: ['s1'],
    });
    // Without scaling the point would be at (50,50) and this box misses it.
    expect(findSketchStrokesInPolygon(rect(40, 40, 60, 60))).toEqual({});
  });
});

describe('getSketchStrokeSelectionBounds', () => {
  it('returns null for an empty selection', () => {
    setNodes([]);
    expect(getSketchStrokeSelectionBounds({})).toBeNull();
  });

  it('unions the selected strokes bbox inflated by half stroke width', () => {
    setNodes([
      makeSketch({
        id: 'a',
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        strokes: [
          { id: 's1', points: [[10, 10]], size: 4 },
          { id: 's2', points: [[90, 90]], size: 4 },
          { id: 's3', points: [[200, 200]], size: 4 }, // not selected
        ],
      }),
    ]);
    // Select s1 + s2; half stroke width = 2 → bbox (8,8)..(92,92).
    const bounds = getSketchStrokeSelectionBounds({ a: ['s1', 's2'] });
    expect(bounds).toEqual({ x: 8, y: 8, width: 84, height: 84 });
  });
});
