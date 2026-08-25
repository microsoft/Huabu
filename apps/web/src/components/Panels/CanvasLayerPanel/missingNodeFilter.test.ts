// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { nodeMatchesLayerFilters } from './missingNodeFilter';

import type { LayerFilterKey } from './layerFilterKey';
import type { DataSourceNodeLike } from './types';

const node = (
  type: string,
  data: DataSourceNodeLike['data'] = { label: type },
): DataSourceNodeLike => ({ id: `${type}-node`, type, data });

describe('nodeMatchesLayerFilters', () => {
  it('shows only missing nodes when the missing filter is active', () => {
    const noTypes = new Set<LayerFilterKey>();

    expect(
      nodeMatchesLayerFilters(
        node('note', { label: 'Missing', contentMissing: true }),
        noTypes,
        true,
      ),
    ).toBe(true);
    expect(nodeMatchesLayerFilters(node('note'), noTypes, true)).toBe(false);
  });

  it('intersects the missing filter with selected node types', () => {
    const imageOnly = new Set<LayerFilterKey>(['image']);

    expect(
      nodeMatchesLayerFilters(
        node('image', { label: 'Missing image', artifactMissing: true }),
        imageOnly,
        true,
      ),
    ).toBe(true);
    expect(
      nodeMatchesLayerFilters(
        node('note', { label: 'Missing note', contentMissing: true }),
        imageOnly,
        true,
      ),
    ).toBe(false);
    expect(nodeMatchesLayerFilters(node('image'), imageOnly, true)).toBe(false);
  });

  it('keeps existing type-only filtering when the missing filter is off', () => {
    const noteOnly = new Set<LayerFilterKey>(['note']);

    expect(nodeMatchesLayerFilters(node('note'), noteOnly, false)).toBe(true);
    expect(nodeMatchesLayerFilters(node('image'), noteOnly, false)).toBe(false);
  });
});
