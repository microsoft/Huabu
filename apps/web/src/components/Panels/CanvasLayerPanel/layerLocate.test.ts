// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveLayerLocate } from './layerLocate';

const base = {
  force: false,
  inRenderedTree: false,
  exists: true,
  isSearchActive: false,
  isFilterActive: false,
};

describe('resolveLayerLocate', () => {
  it('leaves a rendered row to the tree', () => {
    expect(
      resolveLayerLocate({ ...base, inRenderedTree: true, force: true }),
    ).toBe('tree');
  });

  it.each([
    ['search', { isSearchActive: true }],
    ['a type filter', { isFilterActive: true }],
  ])('clears %s only when Layers is the sole locator', (_case, hidden) => {
    expect(resolveLayerLocate({ ...base, ...hidden, force: true })).toBe(
      'clear-filters',
    );
    // With the Canvas showing the node, the user's view of Layers wins.
    expect(resolveLayerLocate({ ...base, ...hidden })).toBe('drop');
  });

  it.each([
    ['a row hidden by default, such as a Sketch', { force: true }],
    ['a node that no longer exists', { force: true, exists: false }],
    [
      'a missing node behind an active search',
      { force: true, exists: false, isSearchActive: true },
    ],
  ])('drops a request for %s', (_case, state) => {
    expect(resolveLayerLocate({ ...base, ...state })).toBe('drop');
  });
});
