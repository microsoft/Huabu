// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { buildNodeNeighbourhoodContext } from './node-neighbourhood.js';

import type { SpatialNode } from '@huabu/shared';

function node(
  id: string,
  x: number,
  parentId?: string,
  type = 'note',
): SpatialNode {
  return {
    id,
    type,
    label: id,
    rect: { x, y: 0, width: 100, height: 100 },
    ...(parentId ? { parentId } : {}),
  };
}

function includedIds(
  nodes: SpatialNode[],
  edges: Array<{ source: string; target: string }>,
) {
  const context = buildNodeNeighbourhoodContext(nodes[0], nodes, edges);
  return new Set(
    context.layers.flatMap((layer) =>
      layer.groups.flatMap((group) => group.nodes.map((item) => item.id)),
    ),
  );
}

describe('buildNodeNeighbourhoodContext', () => {
  it('uses a narrow default radius for ordinary spatial neighbours', () => {
    const ids = includedIds(
      [node('anchor', 0), node('nearby', 500), node('distant', -501)],
      [],
    );

    expect(ids).toContain('nearby');
    expect(ids).not.toContain('distant');
  });

  it('retains the containing frame and all direct siblings beyond the radius', () => {
    const frame = node('frame', 0, undefined, 'frame');
    const anchor = node('anchor', 0, 'frame');
    const sibling = node('sibling', 5000, 'frame');
    const siblingFrame = node('sibling-frame', 7000, 'frame', 'frame');
    const ids = includedIds([anchor, frame, sibling, siblingFrame], []);

    expect(ids).toContain('frame');
    expect(ids).toContain('sibling');
    expect(ids).toContain('sibling-frame');
  });

  it('retains every directly connected node beyond the radius', () => {
    const anchor = node('anchor', 0);
    const connectedSource = node('connected-source', 5000);
    const connectedTarget = node('connected-target', 7000);
    const ids = includedIds(
      [anchor, connectedSource, connectedTarget],
      [
        { source: 'connected-source', target: 'anchor' },
        { source: 'anchor', target: 'connected-target' },
      ],
    );

    expect(ids).toContain('connected-source');
    expect(ids).toContain('connected-target');
  });
});
