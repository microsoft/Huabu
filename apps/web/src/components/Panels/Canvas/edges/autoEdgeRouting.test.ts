// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { routeOrthogonalEdge } from '@huabu/shared/canvas-engine';

import { createRoutingSceneCache, getRouteObstacles } from './autoEdgeRouting';

import type { Node } from '@xyflow/react';

const node = (id: string, x: number, y: number, parentId?: string): Node => ({
  id,
  position: { x, y },
  style: { width: 100, height: 100 },
  data: {},
  parentId,
});
const ports = {
  source: { x: 100, y: 50 },
  target: { x: 600, y: 50 },
  sourceSide: 'right' as const,
  targetSide: 'left' as const,
};

describe('automatic connector scene', () => {
  it('reuses geometry for selection/content changes, but updates a moving unrelated obstacle', () => {
    const read = createRoutingSceneCache();
    const nodes = [
      node('source', 0, 0),
      node('target', 600, 0),
      node('blocker', 250, 0),
    ];
    const snapshot = JSON.stringify(nodes);
    const first = read(nodes);
    expect(
      read(
        nodes.map((n) => ({
          ...n,
          selected: true,
          data: { content: 'edited' },
        })),
      ),
    ).toBe(first);
    expect(read([...nodes].reverse())).toBe(first);
    const moved = read(
      nodes.map((n) =>
        n.id === 'blocker' ? { ...n, position: { x: 250, y: 200 } } : n,
      ),
    );
    expect(moved).not.toBe(first);
    const route = (scene: typeof first) =>
      routeOrthogonalEdge({
        ...ports,
        ...getRouteObstacles(scene, 'source', 'target'),
      });
    expect(route(first).status).toBe('routed');
    expect(route(moved).path).not.toBe(route(first).path);
    expect(JSON.stringify(nodes)).toBe(snapshot);
  });

  it('resolves nested coordinates and omits ancestor backgrounds and hidden obstacles', () => {
    const scene = createRoutingSceneCache()([
      node('frame', 100, 200),
      node('source', 0, 50, 'frame'),
      node('target', 600, 50, 'frame'),
      node('blocker', 300, 20, 'frame'),
      { ...node('hidden', 0, 0), hidden: true },
    ]);
    expect(getRouteObstacles(scene, 'source', 'target')).toEqual({
      sourceRect: { x: 100, y: 250, w: 100, h: 100 },
      targetRect: { x: 700, y: 250, w: 100, h: 100 },
      obstacles: [{ x: 400, y: 220, w: 100, h: 100 }],
    });
    expect(
      getRouteObstacles(scene, 'frame', 'source').sourceRect,
    ).toBeUndefined();
  });

  it.each([
    { hidden: true },
    { parentId: 'frame' },
    { measured: { width: 180, height: 140 } },
  ])('invalidates obstacle geometry for %j', (patch) => {
    const read = createRoutingSceneCache();
    const nodes = [node('frame', 200, 200), node('blocker', 0, 0)];
    const before = read(nodes);
    expect(read([nodes[0], { ...nodes[1], ...patch }])).not.toBe(before);
  });
});
