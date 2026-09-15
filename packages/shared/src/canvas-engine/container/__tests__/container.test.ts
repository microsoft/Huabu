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
  it('accepts ordinary nodes and previews as Frame children only', () => {
    const child = node('child');
    const frame = node('frame', { type: 'frame' });
    const preview = node('preview', { type: 'spacePreview' });
    expect(canParentNode(frame, child)).toBe(true);
    expect(canParentNode(frame, preview)).toBe(true);
    expect(canParentNode(frame, node('nested', { type: 'frame' }))).toBe(true);
    expect(canParentNode(frame, frame)).toBe(false);
    expect(canParentNode(preview, child)).toBe(false);
    expect(canParentNode(node('note'), child)).toBe(false);
    expect(canParentNode(undefined, child)).toBe(false);
    expect(canParentNode(frame, undefined)).toBe(false);
  });

  it('preserves locked Frame membership', () => {
    const nodes = [
      node('frame', { type: 'frame', data: { locked: true } }),
      node('child', { parentId: 'frame' }),
      node('outside'),
    ];
    expect(moveNodeIntoContainer(nodes, 'outside', 'frame')).toBe(nodes);
    expect(moveNodeOutOfContainer(nodes, 'child')).toBe(nodes);
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

  it('moves a selected Frame without independently moving its descendants', () => {
    const nodes = [
      node('frame', {
        type: 'frame',
        position: { x: 100, y: 50 },
        style: { width: 200, height: 100 },
      }),
      node('child', {
        parentId: 'frame',
        position: { x: 20, y: 30 },
      }),
      node('peer', { position: { x: 0, y: 0 } }),
    ];

    const aligned = alignNodes(nodes, 'left', ['frame', 'child', 'peer']);

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
