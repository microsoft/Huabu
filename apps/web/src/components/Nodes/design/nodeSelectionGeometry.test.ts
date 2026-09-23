// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  resizeCornerInset,
  selectionOutlineRadius,
} from './nodeSelectionGeometry';

describe('resizeCornerInset', () => {
  for (const type of ['note', 'frame']) {
    for (const [width, height] of [
      [200, 100],
      [600, 400],
      [2400, 1800],
      [20, 10],
    ]) {
      it(`${type} ${width}×${height} stays tangent across zoom and pointer sizes`, () => {
        for (const zoom of [0.05, 0.5, 1, 2, 5]) {
          for (const size of [8, 14]) {
            const radius =
              Math.min(
                selectionOutlineRadius(type, width, height),
                width / 2,
                height / 2,
              ) * zoom;
            const inwardCorner =
              resizeCornerInset(type, width, height, zoom, size) + size / 2;
            expect(
              Math.hypot(radius - inwardCorner, radius - inwardCorner),
            ).toBeCloseTo(radius + 1.5, 10);
          }
        }
      });
    }
  }
});
