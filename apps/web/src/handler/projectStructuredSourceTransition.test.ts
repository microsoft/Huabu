// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  getAbsolutePosition,
  solveStructuredFrameLayout,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import { projectStructuredSourceTransition } from './projectStructuredSourceTransition';

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
    style: { width: 240, height: 180 },
    measured: { width: 240, height: 180 },
  } as NestableNode;
}

describe('projectStructuredSourceTransition', () => {
  it('moves a deeply nested target by its source branch reflow delta', () => {
    const source = frame('source', { x: 100, y: 50 }, undefined, {
      layoutMode: 'grid',
      gridCount: 2,
      sizing: 'manual',
    });
    const dragged = frame('dragged', { x: 16, y: 16 }, 'source', {
      frameColumn: 0,
      frameRow: 0,
    });
    const middle = frame('middle', { x: 272, y: 16 }, 'source', {
      frameColumn: 1,
      frameRow: 0,
    });
    const inner = frame('inner', { x: 24, y: 32 }, 'middle');
    const nodes = [source, dragged, middle, inner];
    const withoutDragged = nodes.filter((node) => node.id !== 'dragged');
    const sourceLayout = solveStructuredFrameLayout(
      withoutDragged,
      'source',
      'compact',
    );
    const projectedMiddle = sourceLayout?.childPositions.get('middle');
    const currentInner = getAbsolutePosition(nodes, 'inner');
    if (!projectedMiddle || !currentInner) {
      throw new Error('Projection fixture did not resolve');
    }

    const projection = projectStructuredSourceTransition({
      nodes,
      draggedIds: new Set(['dragged']),
      sourceFrameId: 'source',
      targetFrameId: 'inner',
      edges: [],
    });

    expect(projection.reflow).toContainEqual({
      id: 'middle',
      ...projectedMiddle,
    });
    expect(projection.targetFramePosition).toEqual({
      x: currentInner.x + projectedMiddle.x - middle.position.x,
      y: currentInner.y + projectedMiddle.y - middle.position.y,
    });
  });
});
