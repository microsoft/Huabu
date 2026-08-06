// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { alignNodes } from '../../utils/alignment.js';
import {
  applyContainerFit,
  canParentNode,
  computeContainerFit,
  moveNodeIntoContainer,
  moveNodeOutOfContainer,
} from '../index.js';

import type { NestableNode } from '../tree.js';

function node(id: string, options: Partial<NestableNode> = {}): NestableNode {
  return {
    id,
    type: 'note',
    position: { x: 0, y: 0 },
    data: {},
    style: { width: 40, height: 20 },
    ...options,
  };
}

describe('Container policy and reparenting', () => {
  it('accepts only matching node references as Portal children', () => {
    const child = node('child');
    expect(canParentNode(node('frame', { type: 'frame' }), child)).toBe(true);
    const portal = node('portal', {
      type: 'canvasRef',
      data: { targetCanvasId: 'canvas-a' },
    });
    const matchingRef = node('ref', {
      type: 'nodeRef',
      data: {
        target: { canvasId: 'canvas-a', nodeId: 'node-a' },
      },
    });
    const mismatchedRef = node('other-ref', {
      type: 'nodeRef',
      data: {
        target: { canvasId: 'canvas-b', nodeId: 'node-b' },
      },
    });
    expect(canParentNode(portal, child)).toBe(false);
    expect(canParentNode(portal, matchingRef)).toBe(true);
    expect(canParentNode(portal, mismatchedRef)).toBe(false);
    const frameRef = node('frame-ref', {
      type: 'frameRef',
      data: {
        target: { canvasId: 'canvas-a', nodeId: 'node-frame' },
      },
    });
    expect(canParentNode(portal, frameRef)).toBe(true);
    expect(canParentNode(frameRef, matchingRef)).toBe(true);
    expect(canParentNode(frameRef, mismatchedRef)).toBe(false);
    expect(canParentNode(node('frame', { type: 'frame' }), matchingRef)).toBe(
      false,
    );
    expect(canParentNode(node('note'), child)).toBe(false);
  });

  it('preserves absolute position when entering and leaving a Container', () => {
    const nodes = [
      node('child', { position: { x: 120, y: 80 } }),
      node('frame', {
        type: 'frame',
        position: { x: 100, y: 50 },
        style: { width: 200, height: 100 },
      }),
    ];

    const nested = moveNodeIntoContainer(nodes, 'child', 'frame');
    expect(nested.find((candidate) => candidate.id === 'child')).toMatchObject({
      parentId: 'frame',
      position: { x: 20, y: 30 },
    });

    const detached = moveNodeOutOfContainer(nested, 'child');
    const detachedChild = detached.find(
      (candidate) => candidate.id === 'child',
    );
    expect(detachedChild?.parentId).toBeUndefined();
    expect(detachedChild).toMatchObject({
      position: { x: 120, y: 80 },
    });
  });

  it('moves a selected frameRef without independently moving its descendants', () => {
    const nodes = [
      node('frame-ref', {
        type: 'frameRef',
        position: { x: 100, y: 50 },
        style: { width: 200, height: 100 },
      }),
      node('child', {
        type: 'nodeRef',
        parentId: 'frame-ref',
        position: { x: 20, y: 30 },
      }),
      node('peer', { position: { x: 0, y: 0 } }),
    ];

    const aligned = alignNodes(nodes, 'left', ['frame-ref', 'child', 'peer']);

    expect(
      aligned?.find((candidate) => candidate.id === 'child')?.position,
    ).toEqual({ x: 20, y: 30 });
  });
});

describe('Container fit', () => {
  it('supports asymmetric insets and preserves child absolute position', () => {
    const nodes = [
      node('frame', {
        type: 'frame',
        position: { x: 100, y: 100 },
        style: { width: 10, height: 10 },
      }),
      node('child', {
        parentId: 'frame',
        position: { x: 20, y: 30 },
      }),
    ];

    const fit = computeContainerFit(nodes, 'frame', {
      insets: { top: 20, right: 8, bottom: 6, left: 4 },
    });
    expect(fit).toEqual({
      containerId: 'frame',
      position: { x: 116, y: 110 },
      width: 52,
      height: 46,
    });
    if (!fit) throw new Error('Expected Container fit');

    const applied = applyContainerFit(nodes, fit);
    expect(
      applied.find((candidate) => candidate.id === 'child')?.position,
    ).toEqual({ x: 4, y: 20 });
  });
});
