// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { GRID_SIZE, MAX_ZOOM, MIN_ZOOM } from '@/config/canvas';

export const CANVAS_GRID_DOT_RADIUS = 0.85;

/** Nested power-of-two grids; detail fades in before becoming the next base. */
export function canvasGridForZoom(zoom: number) {
  const scale = Number.isFinite(zoom)
    ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
    : 1;
  const worldSpacing = GRID_SIZE / 2 ** Math.floor(Math.log2(scale));
  const spacing = worldSpacing * scale;
  const progress = Math.min(1, Math.max(0, spacing / GRID_SIZE - 1));

  return {
    worldSpacing,
    spacing,
    detailOpacity: progress * progress * (3 - 2 * progress),
  };
}
