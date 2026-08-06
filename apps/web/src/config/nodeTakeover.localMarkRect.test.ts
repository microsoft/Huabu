// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { localMarkRect } from './nodeTakeover';

const NODE_W = 200;
const NODE_H = 120;

/** Right-hand port offset from the node origin, in screen px at `zoom`. */
function rightPortOnScreen(
  rect: { x: number; width: number },
  zoom: number,
): number {
  return (rect.x + rect.width) * zoom;
}

describe('localMarkRect', () => {
  it('is the full node footprint before the glide starts', () => {
    const rect = localMarkRect(NODE_W, NODE_H, 0.2, 0);

    expect(rect).toEqual({ x: 0, y: 0, width: NODE_W, height: NODE_H });
  });

  it('is a square centred on the node once the glide completes', () => {
    const rect = localMarkRect(NODE_W, NODE_H, 0.2, 1);

    expect(rect.width).toBeCloseTo(rect.height);
    expect(rect.x + rect.width / 2).toBeCloseTo(NODE_W / 2);
    expect(rect.y + rect.height / 2).toBeCloseTo(NODE_H / 2);
  });

  it('scales inversely with zoom, so a stale zoom is a multiplicative error', () => {
    // Every length is a screen-px constant over `zoom`. Halving the zoom
    // therefore doubles the rect, for an unchanged appearance on screen. Both
    // zooms here are far enough out that the mark is pinned to `MARK_MIN`, so
    // the only variable left is the 1/zoom conversion.
    const size = (zoom: number) => localMarkRect(NODE_W, NODE_H, zoom, 1).width;

    expect(size(0.01) / size(0.02)).toBeCloseTo(2);
    expect(size(0.005) / size(0.02)).toBeCloseTo(4);
  });

  it('puts a port hundreds of screen px off the node when zoom is stale', () => {
    // The reported failure: a viewport animation zooms in, and a rect computed
    // at the previous, far smaller zoom is laid out at the current one.
    const staleZoom = 0.005;
    const liveZoom = 0.5;

    const stale = localMarkRect(NODE_W, NODE_H, staleZoom, 1);
    const live = localMarkRect(NODE_W, NODE_H, liveZoom, 1);

    // Correct: the port sits within the node's own 100 screen px width.
    expect(rightPortOnScreen(live, liveZoom)).toBeLessThan(100);

    // Stale: it lands far outside it, which is what dragged the edge endpoints
    // measured from these handles off the viewport.
    const error =
      rightPortOnScreen(stale, liveZoom) - rightPortOnScreen(live, liveZoom);
    expect(error).toBeGreaterThan(250);
  });

  it('clamps an out-of-range glide instead of scaling without bound', () => {
    // The observed failure: a diverging smoothstep drove `progress` into the
    // thousands, and every length here is a screen-px constant over `zoom`, so
    // the rect became ~1e8 and was written straight into a CSS offset.
    const settled = localMarkRect(NODE_W, NODE_H, 0.171, 1);

    expect(localMarkRect(NODE_W, NODE_H, 0.171, 1830)).toEqual(settled);
    expect(localMarkRect(NODE_W, NODE_H, 0.171, -9.2)).toEqual(
      localMarkRect(NODE_W, NODE_H, 0.171, 0),
    );
  });

  it('never returns a negative extent', () => {
    for (const glide of [-1e3, -1, 0, 0.5, 1, 1e3]) {
      const rect = localMarkRect(NODE_W, NODE_H, 0.171, glide);
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
  });
});
