// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Position,
} from '@xyflow/system';
import { describe, expect, it } from 'vitest';

import { flattenEdgePath, getEdgeLineType, getEdgePath } from '../edgePath.js';

describe('shared edge geometry', () => {
  const params = {
    sourceX: 90,
    sourceY: 100,
    targetX: -350,
    targetY: 260,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  };

  it.each([
    ['bezier', getBezierPath],
    ['step', getSmoothStepPath],
    ['straight', getStraightPath],
  ] as const)(
    'preserves React Flow %s paths and label positions',
    (type, render) => {
      expect(getEdgePath(params, type)).toEqual(render(params));
      const points = flattenEdgePath(getEdgePath(params, type)[0]);
      expect(points[0]).toEqual({ x: 90, y: 100 });
      expect(points[points.length - 1]).toEqual({ x: -350, y: 260 });
      expect(
        points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
      ).toBe(true);
      expect(points.length).toBeGreaterThanOrEqual(type === 'straight' ? 2 : 3);
    },
  );

  it('uses authored line type before the legacy React Flow type', () => {
    expect(
      getEdgeLineType({ edgeStyle: { lineType: 'straight' } }, 'smoothstep'),
    ).toBe('straight');
    expect(getEdgeLineType(undefined, 'smoothstep')).toBe('step');
    expect(getEdgeLineType(undefined, 'straight')).toBe('straight');
    expect(getEdgeLineType(undefined, 'default')).toBe('bezier');
  });

  it('samples cubic curvature instead of treating the endpoints as a chord', () => {
    const points = flattenEdgePath('M0,0 C0,100 100,100 100,0');
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points).toContainEqual({ x: 50, y: 75 });
    expect(points[points.length - 1]).toEqual({ x: 100, y: 0 });
    expect(points).toHaveLength(9);
  });

  it.each([1, 1000, 1000000])(
    'keeps eight segments per curve at scale %s',
    (scale) => {
      const cubic = flattenEdgePath(
        `M0,0 C0,${100 * scale} ${100 * scale},${100 * scale} ${100 * scale},0`,
      );
      const quadratic = flattenEdgePath(
        `M0,0 Q0,${100 * scale} ${100 * scale},${100 * scale}`,
      );
      expect(cubic).toHaveLength(9);
      expect(quadratic).toHaveLength(9);
      expect(cubic[4]).toEqual({ x: 50 * scale, y: 75 * scale });
      expect(quadratic[4]).toEqual({ x: 25 * scale, y: 75 * scale });
    },
  );

  it('preserves straight segments and each quadratic corner endpoint', () => {
    const points = flattenEdgePath(
      'M0,0 L20,0 Q30,0 30,10 L30,20 Q30,30 40,30 L60,30',
    );
    expect(points).toHaveLength(20);
    expect(points[1]).toEqual({ x: 20, y: 0 });
    expect(points[9]).toEqual({ x: 30, y: 10 });
    expect(points[10]).toEqual({ x: 30, y: 20 });
    expect(points[18]).toEqual({ x: 40, y: 30 });
    expect(points[19]).toEqual({ x: 60, y: 30 });
    expect(flattenEdgePath('M0,0 L100,100')).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]);
  });

  it('handles quadratic corners, negative coordinates and scientific notation', () => {
    const points = flattenEdgePath('M-1e-7,-20 L0,0 Q0,10 10,10 L20,10');
    expect(points[0]).toEqual({ x: -1e-7, y: -20 });
    expect(points).toContainEqual({ x: 2.5, y: 7.5 });
    expect(points[points.length - 1]).toEqual({ x: 20, y: 10 });
  });

  it('reports unsupported generated primitives rather than mis-scoring a partial path', () => {
    expect(() => flattenEdgePath('M0,0 H100')).toThrow(
      'Unsupported generated edge path command',
    );
    expect(() => flattenEdgePath('M0,0 L100')).toThrow('Invalid coordinates');
  });
});
