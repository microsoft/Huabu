// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { GRID_SIZE, MAX_ZOOM, MIN_ZOOM } from '@/config/canvas';

import { canvasGridForZoom } from './canvasGridPolicy';

describe('canvasGridForZoom', () => {
  it('keeps detail spacing bounded throughout the supported zoom range', () => {
    for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.001) {
      const grid = canvasGridForZoom(zoom);
      expect(grid.spacing).toBeGreaterThanOrEqual(GRID_SIZE);
      expect(grid.spacing).toBeLessThan(GRID_SIZE * 2);
      expect(grid.detailOpacity).toBeGreaterThanOrEqual(0);
      expect(grid.detailOpacity).toBeLessThanOrEqual(1);
      expect(Number.isInteger(Math.log2(grid.worldSpacing / GRID_SIZE))).toBe(
        true,
      );
    }
  });

  it.each([0.0625, 0.125, 0.25, 0.5, 1, 2, 4])(
    'hands fully visible detail to the next persistent grid at zoom %s',
    (boundary) => {
      const before = canvasGridForZoom(boundary * (1 - 1e-8));
      const after = canvasGridForZoom(boundary);
      expect(before.detailOpacity).toBeCloseTo(1, 7);
      expect(after.detailOpacity).toBe(0);
      expect(before.worldSpacing).toBe(after.worldSpacing * 2);
      expect(before.spacing).toBeCloseTo(after.spacing * 2, 5);
    },
  );

  it('subdivides on zoom-in and coarsens on zoom-out without changing the base unit', () => {
    expect(canvasGridForZoom(0.05).worldSpacing).toBe(GRID_SIZE * 32);
    expect(canvasGridForZoom(1).worldSpacing).toBe(GRID_SIZE);
    expect(canvasGridForZoom(5).worldSpacing).toBe(GRID_SIZE / 4);
    expect(canvasGridForZoom(1.5).detailOpacity).toBeCloseTo(0.5);
  });

  it.each([Number.NaN, Infinity, -Infinity])(
    'handles invalid zoom %s',
    (zoom) => {
      expect(canvasGridForZoom(zoom)).toEqual(canvasGridForZoom(1));
    },
  );

  it('clamps finite out-of-range zooms', () => {
    expect(canvasGridForZoom(0)).toEqual(canvasGridForZoom(MIN_ZOOM));
    expect(canvasGridForZoom(-1)).toEqual(canvasGridForZoom(MIN_ZOOM));
    expect(canvasGridForZoom(100)).toEqual(canvasGridForZoom(MAX_ZOOM));
  });
});
