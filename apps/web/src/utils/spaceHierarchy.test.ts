// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { isVisibleWorldNode, spaceAncestorIds } from './spaceHierarchy';

describe('Space hierarchy presentation', () => {
  const summaries = {
    root: { parentSpaceId: null },
    child: { parentSpaceId: 'root' },
    leaf: { parentSpaceId: 'child' },
  };
  it('uses canonical ancestry, independent of the shortcut used to enter', () => {
    expect(spaceAncestorIds('leaf', summaries)).toEqual([
      'root',
      'child',
      'leaf',
    ]);
    expect(spaceAncestorIds('missing', summaries)).toEqual(['missing']);
  });
  it('hides only nested managed World entries without modifying persisted geometry', () => {
    const node = {
      id: 'node-entry',
      type: 'spacePreview',
      position: { x: 42, y: 84 },
      data: { targetCanvasId: 'child' },
    };
    const before = structuredClone(node);
    expect(isVisibleWorldNode(node, 'world', 'world', summaries)).toBe(false);
    expect(isVisibleWorldNode(node, 'root', 'world', summaries)).toBe(true);
    expect(
      isVisibleWorldNode(
        { type: 'note', data: {} },
        'world',
        'world',
        summaries,
      ),
    ).toBe(true);
    expect(
      isVisibleWorldNode(node, 'world', 'world', {
        ...summaries,
        child: { parentSpaceId: null },
      }),
    ).toBe(true);
    expect(node).toEqual(before);
  });
  it('does not expose all entries before hierarchy metadata has loaded', () => {
    expect(
      isVisibleWorldNode(
        { type: 'spacePreview', data: { targetCanvasId: 'root' } },
        'world',
        'world',
        {},
      ),
    ).toBe(false);
  });
});
