// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { getEdgeLabelRenderZ } from './edgeZ';

describe('getEdgeLabelRenderZ', () => {
  it('places the label above both connected nodes', () => {
    expect(getEdgeLabelRenderZ(4, 7, 3)).toBe(8);
  });

  it('also stays above an explicitly elevated edge', () => {
    expect(getEdgeLabelRenderZ(10, 7, 3)).toBe(11);
  });
});
