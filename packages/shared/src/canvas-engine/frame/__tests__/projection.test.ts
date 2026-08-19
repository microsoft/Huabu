// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { applyGridLayout } from '../../autoLayout/gridLayout.js';
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

    expect(projectedSource?.style).toMatchObject({ width: 112, height: 92 });
    expect(projectedSource?.position).toEqual(expectedSourcePosition);
    expect(projected.find((node) => node.id === 'remaining')?.position).toEqual(
      { x: 16, y: 16 },
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
});
