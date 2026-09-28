// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { localMarkRect } from './nodeTakeover';

describe('localMarkRect', () => {
  it('retains the node footprint before takeover', () => {
    expect(localMarkRect(200, 120, 0.2, 0)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 120,
    });
  });
  it('centers the actual painted diameter supplied by the mark', () => {
    expect(localMarkRect(200, 120, 0.2, 1, 100)).toEqual({
      x: 50,
      y: 10,
      width: 100,
      height: 100,
    });
    expect(localMarkRect(200, 120, 0.2, 0.5, 100)).toEqual({
      x: 25,
      y: 5,
      width: 150,
      height: 110,
    });
  });
  it('is invariant under zoom, including the minimum viewport', () => {
    for (const zoom of [0.005, 0.05, 0.1, 0.24, 0.3, 1, 5]) {
      expect(localMarkRect(200, 120, zoom, 1)).toEqual(
        localMarkRect(200, 120, 1, 1),
      );
    }
  });
  it('clamps divergent glide progress', () => {
    expect(localMarkRect(200, 120, 0.1, 1830)).toEqual(
      localMarkRect(200, 120, 0.1, 1),
    );
    expect(localMarkRect(200, 120, 0.1, -9)).toEqual(
      localMarkRect(200, 120, 0.1, 0),
    );
  });
});
