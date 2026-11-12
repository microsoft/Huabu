// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { flattenEdgePath } from '../edgePath.js';
import { routeOrthogonalEdge } from '../orthogonalRouting.js';

import type {
  OrthogonalPoint,
  OrthogonalRect,
  OrthogonalRouteOptions,
  OrthogonalSide,
} from '../orthogonalRouting.js';

const base: OrthogonalRouteOptions = {
  source: { x: 0, y: 0 },
  target: { x: 300, y: 0 },
  sourceSide: 'right',
  targetSide: 'left',
  obstacles: [],
  clearance: 10,
};

function crossesInterior(
  a: OrthogonalPoint,
  b: OrthogonalPoint,
  r: OrthogonalRect,
) {
  let lo = 0;
  let hi = 1;
  for (const [start, delta, min, max] of [
    [a.x, b.x - a.x, r.x + 0.001, r.x + r.w - 0.001],
    [a.y, b.y - a.y, r.y + 0.001, r.y + r.h - 0.001],
  ]) {
    if (Math.abs(delta) < 0.00001) {
      if (start < min || start > max) return false;
    } else {
      const p = (min - start) / delta;
      const q = (max - start) / delta;
      lo = Math.max(lo, Math.min(p, q));
      hi = Math.min(hi, Math.max(p, q));
      if (lo > hi) return false;
    }
  }
  return true;
}

function expectClear(
  points: OrthogonalPoint[],
  obstacles: readonly OrthogonalRect[],
) {
  for (let i = 1; i < points.length; i++) {
    for (const rect of obstacles) {
      expect(crossesInterior(points[i - 1], points[i], rect)).toBe(false);
    }
  }
}

describe('routeOrthogonalEdge', () => {
  it('bends around an intervening card with an obstacle-free rounded path', () => {
    const obstacles = [{ x: 100, y: -40, w: 80, h: 80 }];
    const result = routeOrthogonalEdge({ ...base, obstacles });
    expect(result.status).toBe('routed');
    expect(result.points[0]).toEqual(base.source);
    expect(result.points[result.points.length - 1]).toEqual(base.target);
    expect(result.points[1].x).toBeGreaterThan(0);
    expect(result.points[result.points.length - 2].x).toBeLessThan(300);
    expect(result.path).toContain('Q');
    expectClear(result.points, obstacles);
    expectClear(flattenEdgePath(result.path), obstacles);
    expect(Number.isFinite(result.labelX + result.labelY)).toBe(true);
  });

  it('routes several staggered obstacles deterministically regardless of their input order', () => {
    const obstacles = [
      { x: 70, y: -120, w: 40, h: 150 },
      { x: 150, y: -30, w: 40, h: 150 },
      { x: 220, y: -120, w: 40, h: 150 },
    ];
    const route = routeOrthogonalEdge({ ...base, obstacles });
    expect(route.status).toBe('routed');
    expectClear(route.points, obstacles);
    expect(route).toEqual(
      routeOrthogonalEdge({ ...base, obstacles: [...obstacles].reverse() }),
    );
  });

  it('recomputes the route when the obstacle moves into its previous corridor', () => {
    const first = routeOrthogonalEdge({
      ...base,
      obstacles: [{ x: 100, y: -40, w: 80, h: 80 }],
    });
    const channel = first.points.find((p) => p.y !== 0)?.y ?? 0;
    expect(channel).not.toBe(0);
    const obstacles = [{ x: 100, y: channel - 20, w: 80, h: 40 }];
    const next = routeOrthogonalEdge({ ...base, obstacles });
    expect(next.status).toBe('routed');
    expect(next.points).not.toEqual(first.points);
    expectClear(next.points, obstacles);
  });

  it('keeps the rest of a same-side route outside both endpoint cards', () => {
    const sourceRect = { x: -80, y: -40, w: 80, h: 80 };
    const targetRect = { x: 220, y: -40, w: 80, h: 80 };
    const result = routeOrthogonalEdge({
      ...base,
      targetSide: 'right',
      sourceRect,
      targetRect,
    });
    expect(result.status).toBe('routed');
    expect(result.points[result.points.length - 2].x).toBeGreaterThan(300);
    expectClear(result.points, [sourceRect, targetRect]);
    expectClear(flattenEdgePath(result.path), [sourceRect, targetRect]);
  });

  it('uses a different channel when another edge already occupies the direct corridor', () => {
    const result = routeOrthogonalEdge({
      ...base,
      occupiedSegments: [{ start: { x: 24, y: 0 }, end: { x: 276, y: 0 } }],
    });
    expect(result.status).toBe('routed');
    expect(result.points.some((point) => point.y !== 0)).toBe(true);
  });

  it('provides opposite preferred lanes for parallel connections', () => {
    const upper = routeOrthogonalEdge({ ...base, laneOffset: -24 });
    const lower = routeOrthogonalEdge({ ...base, laneOffset: 24 });
    expect(upper.points.some((point) => point.y < 0)).toBe(true);
    expect(lower.points.some((point) => point.y > 0)).toBe(true);
  });

  it('reports a finite bounded fallback when a different card covers the source port', () => {
    const result = routeOrthogonalEdge({
      ...base,
      obstacles: [{ x: -20, y: -20, w: 70, h: 40 }],
    });
    expect(result.status).toBe('fallback');
    expect(result.path).not.toMatch(/NaN|Infinity/);
    expect(result.points[1].x).toBeGreaterThan(0);
  });

  it('respects a tiny search budget without losing endpoints or producing a diagonal segment', () => {
    const obstacles = Array.from({ length: 160 }, (_, index) => ({
      x: 50 + index * 7,
      y: -30 + (index % 9) * 8,
      w: 4,
      h: 15,
    }));
    const result = routeOrthogonalEdge({
      ...base,
      obstacles,
      maxGridPoints: 16,
    });
    expect(result.points[0]).toEqual(base.source);
    expect(result.points[result.points.length - 1]).toEqual(base.target);
    for (let index = 1; index < result.points.length; index++) {
      const a = result.points[index - 1];
      const b = result.points[index];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('preserves outward departure and inward arrival for every pair of port sides', () => {
    const sourceRect = { x: 0, y: 0, w: 80, h: 60 };
    const targetRect = { x: 240, y: 170, w: 100, h: 90 };
    const anchors = (
      r: OrthogonalRect,
    ): Record<OrthogonalSide, OrthogonalPoint> => ({
      left: { x: r.x, y: r.y + r.h / 2 },
      right: { x: r.x + r.w, y: r.y + r.h / 2 },
      top: { x: r.x + r.w / 2, y: r.y },
      bottom: { x: r.x + r.w / 2, y: r.y + r.h },
    });
    const normals = {
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
      top: { x: 0, y: -1 },
      bottom: { x: 0, y: 1 },
    };
    const sides: OrthogonalSide[] = ['left', 'right', 'top', 'bottom'];
    for (const sourceSide of sides) {
      for (const targetSide of sides) {
        const source = anchors(sourceRect)[sourceSide];
        const target = anchors(targetRect)[targetSide];
        const result = routeOrthogonalEdge({
          ...base,
          source,
          target,
          sourceSide,
          targetSide,
          sourceRect,
          targetRect,
        });
        expect(result.status).toBe('routed');
        const first = result.points[1];
        const last = result.points[result.points.length - 2];
        expect(
          (first.x - source.x) * normals[sourceSide].x +
            (first.y - source.y) * normals[sourceSide].y,
        ).toBeGreaterThan(0);
        expect(
          (last.x - target.x) * normals[targetSide].x +
            (last.y - target.y) * normals[targetSide].y,
        ).toBeGreaterThan(0);
        expectClear(flattenEdgePath(result.path), [sourceRect, targetRect]);
      }
    }
  });

  it('keeps local parallel routes separated when hundreds of unrelated cards are far away', () => {
    const obstacles = Array.from({ length: 257 }, (_, index) => ({
      x: 10_000 + index * 50,
      y: 10_000,
      w: 20,
      h: 20,
    }));
    const upper = routeOrthogonalEdge({ ...base, obstacles, laneOffset: -14 });
    const lower = routeOrthogonalEdge({ ...base, obstacles, laneOffset: 14 });
    expect(upper.status).toBe('routed');
    expect(lower.status).toBe('routed');
    expect(upper.points.some((point) => point.y < 0)).toBe(true);
    expect(lower.points.some((point) => point.y > 0)).toBe(true);
    expect(upper.path).not.toEqual(lower.path);
    expectClear(flattenEdgePath(upper.path), obstacles);
    expectClear(flattenEdgePath(lower.path), obstacles);
  });

  it('keeps lane preferences when the obstacle budget requires an exterior detour', () => {
    const obstacles = Array.from({ length: 257 }, () => ({
      x: 100,
      y: -40,
      w: 80,
      h: 80,
    }));
    const upper = routeOrthogonalEdge({ ...base, obstacles, laneOffset: -14 });
    const lower = routeOrthogonalEdge({ ...base, obstacles, laneOffset: 14 });
    expect(upper.points.some((point) => point.y < 0)).toBe(true);
    expect(lower.points.some((point) => point.y > 0)).toBe(true);
    expectClear(flattenEdgePath(upper.path), obstacles);
    expectClear(flattenEdgePath(lower.path), obstacles);
  });

  it('checks all obstacles and respects an already occupied fallback corridor', () => {
    const obstacles = Array.from({ length: 257 }, () => ({
      x: 100,
      y: -40,
      w: 80,
      h: 80,
    }));
    const first = routeOrthogonalEdge({ ...base, obstacles });
    const occupiedSegments = first.points
      .slice(1)
      .map((end, index) => ({ start: first.points[index], end }));
    const second = routeOrthogonalEdge({
      ...base,
      obstacles,
      occupiedSegments,
    });
    expect(second.path).not.toBe(first.path);
    expectClear(second.points, obstacles);
    // A late entry must still block a candidate, even if earlier obstacles are distant.
    const far = Array.from({ length: 257 }, (_, index) => ({
      x: 10_000 + index,
      y: 10_000,
      w: 10,
      h: 10,
    }));
    const blocking = { x: 120, y: -20, w: 60, h: 40 };
    const routed = routeOrthogonalEdge({
      ...base,
      obstacles: [...far, blocking],
    });
    expectClear(flattenEdgePath(routed.path), [blocking]);
  });

  it('finds a compact clear middle channel before a tiny grid forces a perimeter detour', () => {
    const obstacles = [
      { x: 200, y: -20, w: 30, h: 100 },
      { x: 70, y: 20, w: 30, h: 100 },
    ];
    const result = routeOrthogonalEdge({
      ...base,
      target: { x: 300, y: 100 },
      obstacles,
      maxGridPoints: 16,
    });
    expect(result.status).toBe('routed');
    expect(result.points.every((point) => point.y >= 0 && point.y <= 100)).toBe(
      true,
    );
    expectClear(flattenEdgePath(result.path), obstacles);
  });

  it('searches beyond the compact candidates when all their channels are already occupied', () => {
    const occupiedSegments = [-12, 0, 12].map((y) => ({
      start: { x: 24, y },
      end: { x: 276, y },
    }));
    const result = routeOrthogonalEdge({ ...base, occupiedSegments });
    expect(result.status).toBe('routed');
    expect(result.points.some((point) => Math.abs(point.y) >= 24)).toBe(true);
  });
});
