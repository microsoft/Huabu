// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  applyGridLayout,
  applyStructuredFrameRelayout,
} from '../../autoLayout/gridLayout.js';
import { moveNodeIntoContainer } from '../../container/mutation.js';
import { projectAffectedFrameGeometry } from '../projection.js';

import type { NestableNode } from '../../container/tree.js';

function frame(
  id: string,
  position: { x: number; y: number },
  parentId?: string,
  data: Record<string, unknown> = {},
): NestableNode {
  return {
    id,
    type: 'frame',
    parentId,
    position,
    data,
    style: { width: 180, height: 140 },
    measured: { width: 180, height: 140 },
  } as NestableNode;
}

describe('projectAffectedFrameGeometry', () => {
  it.each([100, 400])(
    'fits free ancestors after structured descendants measure %spx tall',
    (height) => {
      const outer = frame('outer', { x: 0, y: 0 }, undefined, {
        sizing: 'hug',
      });
      const inner = frame('inner', { x: 20, y: 64 }, 'outer', {
        layoutMode: 'grid',
        gridCount: 1,
        sizing: 'hug',
      });
      const child: NestableNode = {
        id: 'child',
        type: 'question',
        parentId: 'inner',
        position: { x: 20, y: 64 },
        data: { frameColumn: 0, frameRow: 0 },
        style: { width: 200 },
        measured: { width: 200, height },
      };
      const nodes = projectAffectedFrameGeometry(
        [outer, inner, child],
        ['inner'],
      ).nodes;
      expect(nodes.find((node) => node.id === 'inner')?.style).toMatchObject({
        width: 240,
        height: height + 84,
      });
      expect(nodes.find((node) => node.id === 'outer')?.style).toMatchObject({
        width: 280,
        height: height + 168,
      });
      expect(projectAffectedFrameGeometry(nodes, ['inner']).nodes).toEqual(
        nodes,
      );
    },
  );

  it('projects alternating free and Grid levels inside-out while keeping Manual ancestors pinned', () => {
    const manual = frame('manual', { x: 0, y: 0 }, undefined, {
      sizing: 'manual',
    });
    const outer = frame('outer', { x: 20, y: 64 }, 'manual', { sizing: 'hug' });
    const grid = frame('grid', { x: 20, y: 64 }, 'outer', {
      layoutMode: 'grid',
      gridCount: 1,
    });
    const free = frame('free', { x: 20, y: 64 }, 'grid', {
      frameColumn: 0,
      frameRow: 0,
    });
    const inner = frame('inner', { x: 20, y: 64 }, 'free', {
      layoutMode: 'grid',
      gridCount: 1,
    });
    const child: NestableNode = {
      id: 'child',
      type: 'note',
      parentId: 'inner',
      position: { x: 20, y: 64 },
      data: { frameColumn: 0, frameRow: 0 },
      style: { width: 200, height: 400 },
    };
    const nodes = projectAffectedFrameGeometry(
      [manual, outer, grid, free, inner, child],
      ['outer', 'inner'],
    ).nodes;
    for (const [index, id] of ['inner', 'free', 'grid', 'outer'].entries()) {
      expect(nodes.find((node) => node.id === id)?.style?.height).toBe(
        400 + 84 * (index + 1),
      );
    }
    expect(nodes.find((node) => node.id === 'manual')).toBe(manual);
    expect(projectAffectedFrameGeometry(nodes, ['inner']).nodes).toEqual(nodes);
  });

  it('fits an inner source Frame and reflows its structured ancestor', () => {
    const outer = frame('outer', { x: 0, y: 0 }, undefined, {
      layoutMode: 'grid',
      gridCount: 2,
      sizing: 'manual',
    });
    const peer = frame('peer', { x: 0, y: 0 }, 'outer', {
      frameColumn: 0,
      frameRow: 0,
      sizing: 'manual',
    });
    const source = frame('source', { x: 0, y: 0 }, 'outer', {
      frameColumn: 1,
      frameRow: 0,
      sizing: 'hug',
    });
    const remaining = {
      id: 'remaining',
      type: 'note',
      parentId: 'source',
      position: { x: 30, y: 30 },
      data: {},
      style: { width: 80, height: 60 },
      measured: { width: 80, height: 60 },
    } as NestableNode;
    const initial = [outer, peer, source, remaining];
    const initialLayout = applyGridLayout(initial, 'outer', 2);
    if (!initialLayout) throw new Error('Outer layout did not resolve');
    const laidOut = initial.map((node) => {
      const position = initialLayout.childPositions.get(node.id);
      return position ? { ...node, position } : node;
    });

    const projected = projectAffectedFrameGeometry(
      laidOut,
      ['source'],
      [],
    ).nodes;
    const projectedSource = projected.find((node) => node.id === 'source');
    const expectedSourcePosition = applyGridLayout(
      projected,
      'outer',
      2,
    )?.childPositions.get('source');

    expect(projectedSource?.style).toMatchObject({ width: 120, height: 144 });
    expect(projectedSource?.position).toEqual(expectedSourcePosition);
    expect(projected.find((node) => node.id === 'remaining')?.position).toEqual(
      { x: 20, y: 64 },
    );
  });

  it('preserves unrelated node references outside the affected hierarchy', () => {
    const source = frame('source', { x: 0, y: 0 }, undefined, {
      sizing: 'hug',
    });
    const child = {
      id: 'child',
      type: 'note',
      parentId: 'source',
      position: { x: 30, y: 30 },
      data: {},
      style: { width: 80, height: 60 },
      measured: { width: 80, height: 60 },
    } as NestableNode;
    const unrelated = {
      id: 'unrelated',
      type: 'note',
      position: { x: 2_000, y: 2_000 },
      data: {},
      style: { width: 200, height: 100 },
      measured: { width: 200, height: 100 },
    } as NestableNode;

    const projected = projectAffectedFrameGeometry(
      [source, child, unrelated],
      ['source'],
    ).nodes;

    expect(projected.find((node) => node.id === 'unrelated')).toBe(unrelated);
  });

  it('fits a free target after projected entry and reflows its outer grid', () => {
    const outer = frame('outer', { x: 0, y: 0 }, undefined, {
      layoutMode: 'grid',
      gridCount: 2,
      sizing: 'manual',
    });
    const peer = frame('peer', { x: 30, y: 30 }, 'outer', {
      frameColumn: 0,
      frameRow: 0,
      sizing: 'manual',
    });
    const target = frame('target', { x: 260, y: 30 }, 'outer', {
      frameColumn: 1,
      frameRow: 0,
      sizing: 'hug',
    });
    const existing = {
      id: 'existing',
      type: 'note',
      parentId: 'target',
      position: { x: 20, y: 20 },
      data: {},
      style: { width: 80, height: 60 },
      measured: { width: 80, height: 60 },
    } as NestableNode;
    const dragged = {
      id: 'dragged',
      type: 'note',
      position: { x: 500, y: 120 },
      data: {},
      style: { width: 100, height: 80 },
      measured: { width: 100, height: 80 },
    } as NestableNode;
    const entered = moveNodeIntoContainer(
      [outer, peer, target, existing, dragged],
      'dragged',
      'target',
    );
    const projected = projectAffectedFrameGeometry(entered, ['target']).nodes;
    const projectedTarget = projected.find((node) => node.id === 'target');
    const expectedTargetPosition = applyGridLayout(
      projected,
      'outer',
      2,
    )?.childPositions.get('target');

    expect(projectedTarget?.style?.width).toBeGreaterThan(180);
    expect(projectedTarget?.position).toEqual(expectedTargetPosition);
  });
});

describe('applyStructuredFrameRelayout ordering', () => {
  it('stabilizes outer Hug geometry even when callers list ancestors first', () => {
    const outer = frame('outer', { x: 0, y: 0 }, undefined, {
      layoutMode: 'row',
      gridCount: 1,
      sizing: 'hug',
    });
    const middle = frame('middle', { x: 20, y: 20 }, 'outer', {
      layoutMode: 'row',
      gridCount: 1,
      sizing: 'hug',
      frameRow: 0,
    });
    const child = {
      id: 'child',
      type: 'note',
      parentId: 'middle',
      position: { x: 20, y: 20 },
      data: { frameRow: 0 },
      style: { width: 500, height: 300 },
      measured: { width: 500, height: 300 },
    } as NestableNode;

    const first = applyStructuredFrameRelayout(
      [outer, middle, child],
      ['outer', 'middle'],
    ).nodes;
    const second = applyStructuredFrameRelayout(first, [
      'outer',
      'middle',
    ]).nodes;
    const firstOuter = first.find((node) => node.id === 'outer');
    const secondOuter = second.find((node) => node.id === 'outer');

    expect(firstOuter?.style?.height).toBe(secondOuter?.style?.height);
  });
});
