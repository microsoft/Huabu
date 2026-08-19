// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  applyGridLayout,
  describeStructuredDropZone,
  getAbsolutePosition,
  getNodeSize,
  moveNodeOutOfFrame,
  projectAffectedFrameGeometry,
} from '@huabu/shared/canvas-engine';

import { projectStructuredTargetGeometry } from './projectStructuredTargetGeometry';

import type {
  NestableNode,
  StructuredDropZone,
} from '@huabu/shared/canvas-engine';

describe('projectStructuredTargetGeometry', () => {
  it('applies target size and peer reflow before projecting its outer grid', () => {
    const outer = {
      id: 'outer',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { layoutMode: 'grid', gridCount: 2, sizing: 'manual' },
      style: { width: 600, height: 300 },
      measured: { width: 600, height: 300 },
    } as NestableNode;
    const peerFrame = {
      id: 'peer-frame',
      type: 'frame',
      parentId: 'outer',
      position: { x: 30, y: 30 },
      data: { frameColumn: 0, frameRow: 0, sizing: 'manual' },
      style: { width: 180, height: 140 },
      measured: { width: 180, height: 140 },
    } as NestableNode;
    const target = {
      id: 'target',
      type: 'frame',
      parentId: 'outer',
      position: { x: 300, y: 30 },
      data: {
        frameColumn: 1,
        frameRow: 0,
        layoutMode: 'grid',
        gridCount: 1,
        sizing: 'hug',
      },
      style: { width: 180, height: 140 },
      measured: { width: 180, height: 140 },
    } as NestableNode;
    const peer = {
      id: 'peer',
      type: 'note',
      parentId: 'target',
      position: { x: 20, y: 20 },
      data: { frameColumn: 0, frameRow: 0 },
      style: { width: 80, height: 60 },
      measured: { width: 80, height: 60 },
    } as NestableNode;
    const zone = {
      kind: 'into-existing',
      x: 120,
      y: 20,
      width: 80,
      height: 60,
      frameSize: { width: 240, height: 120 },
      reflow: [{ id: 'peer', x: 16, y: 16 }],
      context: {
        axis: 'grid',
        tracks: [],
        activeTrack: 0,
        rows: [],
        activeRow: 0,
      },
    } as StructuredDropZone;

    const projected = projectStructuredTargetGeometry({
      nodes: [outer, peerFrame, target, peer],
      targetFrameId: 'target',
      zone,
      edges: [],
    });
    const projectedTarget = projected.find((node) => node.id === 'target');
    const expectedTargetPosition = applyGridLayout(
      projected,
      'outer',
      2,
    )?.childPositions.get('target');

    expect(projectedTarget?.style).toMatchObject({ width: 240, height: 120 });
    expect(projectedTarget?.position).toEqual(expectedTargetPosition);
    expect(projected.find((node) => node.id === 'peer')?.position).toEqual({
      x: 16,
      y: 16,
    });
  });

  it('solves an outer target after its nested source hierarchy has shrunk', () => {
    const outer = {
      id: 'outer',
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { layoutMode: 'grid', gridCount: 2, sizing: 'hug' },
      style: { width: 600, height: 360 },
      measured: { width: 600, height: 360 },
    } as NestableNode;
    const middle = {
      id: 'middle',
      type: 'frame',
      parentId: 'outer',
      position: { x: 30, y: 30 },
      data: { frameColumn: 0, frameRow: 0, sizing: 'hug' },
      style: { width: 260, height: 220 },
      measured: { width: 260, height: 220 },
    } as NestableNode;
    const inner = {
      id: 'inner',
      type: 'frame',
      parentId: 'middle',
      position: { x: 20, y: 20 },
      data: { sizing: 'hug' },
      style: { width: 180, height: 160 },
      measured: { width: 180, height: 160 },
    } as NestableNode;
    const remaining = {
      id: 'remaining',
      type: 'note',
      parentId: 'inner',
      position: { x: 20, y: 20 },
      data: {},
      style: { width: 80, height: 60 },
      measured: { width: 80, height: 60 },
    } as NestableNode;
    const dragged = {
      id: 'dragged',
      type: 'note',
      parentId: 'inner',
      position: { x: 20, y: 100 },
      data: {},
      style: { width: 100, height: 80 },
      measured: { width: 100, height: 80 },
    } as NestableNode;
    const liveNodes = [outer, middle, inner, remaining, dragged];
    const detached = moveNodeOutOfFrame(liveNodes, 'dragged');
    const sourceFuture = projectAffectedFrameGeometry(detached, [
      'inner',
    ]).nodes;
    const outerAbs = getAbsolutePosition(sourceFuture, 'outer');
    const draggedAbs = getAbsolutePosition(sourceFuture, 'dragged');
    const draggedNode = sourceFuture.find((node) => node.id === 'dragged');
    if (!outerAbs || !draggedAbs || !draggedNode) {
      throw new Error('Projected hierarchy fixture did not resolve');
    }
    const size = getNodeSize(draggedNode);
    const zone = describeStructuredDropZone(
      sourceFuture,
      'outer',
      { x: 80, y: 300 },
      'grid',
      2,
      {
        id: 'dragged',
        x: draggedAbs.x - outerAbs.x,
        y: draggedAbs.y - outerAbs.y,
        width: size.width,
        height: size.height,
      },
    );
    if (!zone) throw new Error('Outer drop zone did not resolve');

    const projected = projectStructuredTargetGeometry({
      nodes: sourceFuture,
      targetFrameId: 'outer',
      zone,
      edges: [],
    });
    const projectedOuter = projected.find((node) => node.id === 'outer');
    const projectedInner = projected.find((node) => node.id === 'inner');
    if (!projectedInner) throw new Error('Projected inner Frame is missing');

    expect(projectedOuter?.style?.height).toBe(zone.frameSize.height);
    expect(getNodeSize(projectedInner).height).toBeLessThan(
      getNodeSize(inner).height,
    );
  });
});
